// SQLOptimizer runtime — implements the actual SQL optimization logic
// that the SpeckDL state machine orchestrates.

export type PlanOp = 'Scan' | 'Filter' | 'Join' | 'Project' | 'Aggregate' | 'Sort' | 'Limit';

export interface PlanNode {
  id: string;
  op: PlanOp;
  table?: string;
  predicate?: string;
  joinType?: string;
  leftChild?: string;
  rightChild?: string;
  onClause?: string;
  columns?: string[];
  groupBy?: string;
  orderBy?: string;
  limit?: number;
  estimatedRows: number;
  children: string[];
}

export interface PlanTree {
  nodes: Record<string, PlanNode>;
  root: string;
}

export interface TableStats {
  rowCount: number;
  columns: Record<string, { ndv: number; nullFraction: number; avgWidth: number }>;
}

// ─── SQL Parser ─────────────────────────────────────────────

interface SQLParts {
  select: string;
  from: string;
  joins: { type: string; table: string; on: string }[];
  where: string;
  groupBy: string;
  orderBy: string;
  limit: string;
}

function parseSQL(sql: string): SQLParts {
  const s = sql.trim().replace(/\s+/g, ' ').replace(/;$/, '');

  // Extract clauses by keyword positions
  const selectMatch = s.match(/\bSELECT\s+(.+?)\s+FROM\b/i);
  const select = selectMatch ? selectMatch[1].trim() : '*';

  // Extract FROM table (before any JOIN or WHERE or GROUP BY etc.)
  const fromMatch = s.match(/\bFROM\s+(\w+)/i);
  const from = fromMatch ? fromMatch[1] : '';

  // Extract JOINs
  const joins: { type: string; table: string; on: string }[] = [];
  const joinRegex = /\b(INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|JOIN)\s+(\w+)(?:\s+AS\s+\w+)?\s+ON\s+(\w+\.\w+\s*=\s*\w+\.\w+)/gi;
  let jm: RegExpExecArray | null;
  while ((jm = joinRegex.exec(s)) !== null) {
    joins.push({
      type: jm[1].toUpperCase().replace(/\s+/g, ' '),
      table: jm[2],
      on: jm[3].trim()
    });
  }

  // Extract WHERE
  const whereMatch = s.match(/\bWHERE\s+(.+?)(?:\s+GROUP\s+BY\b|\s+HAVING\b|\s+ORDER\s+BY\b|\s+LIMIT\b|\s*$)/i);
  const where = whereMatch ? whereMatch[1].trim() : '';

  // Extract GROUP BY (stop before HAVING)
  const groupMatch = s.match(/\bGROUP\s+BY\s+(.+?)(?:\s+HAVING\b|\s+ORDER\s+BY\b|\s+LIMIT\b|\s*$)/i);
  const groupBy = groupMatch ? groupMatch[1].trim() : '';

  // Extract ORDER BY
  const orderMatch = s.match(/\bORDER\s+BY\s+(.+?)(?:\s+LIMIT\b|\s*$)/i);
  const orderBy = orderMatch ? orderMatch[1].trim() : '';

  // Extract LIMIT
  const limitMatch = s.match(/\bLIMIT\s+(\d+)/i);
  const limit = limitMatch ? limitMatch[1] : '';

  return { select, from, joins, where, groupBy, orderBy, limit };
}

// ─── Plan Construction ──────────────────────────────────────

let nodeIdCounter = 0;

function nextId(prefix: string): string {
  return `${prefix}_${nodeIdCounter++}`;
}

export function resetIdCounter(): void {
  nodeIdCounter = 0;
}

export function buildInitialPlan(sql: string, stats: Record<string, TableStats>): PlanTree {
  resetIdCounter();
  const parts = parseSQL(sql);
  const nodes: Record<string, PlanNode> = {};
  let currentRoot: string;

  // Build scan node for FROM table
  const tableName = parts.from;
  const tableRows = stats[tableName]?.rowCount ?? 1000;
  const scanId = nextId('scan');
  nodes[scanId] = { id: scanId, op: 'Scan', table: tableName, estimatedRows: tableRows, children: [] };
  currentRoot = scanId;

  // Build JOIN nodes
  for (const join of parts.joins) {
    const joinRows = stats[join.table]?.rowCount ?? 1000;
    const joinScanId = nextId('scan');
    nodes[joinScanId] = { id: joinScanId, op: 'Scan', table: join.table, estimatedRows: joinRows, children: [] };

    const parentId = currentRoot;
    const parentRows = nodes[parentId].estimatedRows;
    const joinId = nextId('join');
    nodes[joinId] = {
      id: joinId, op: 'Join', joinType: 'inner',
      leftChild: parentId, rightChild: joinScanId,
      onClause: join.on,
      estimatedRows: Math.ceil(parentRows * joinRows * 0.1),
      children: [parentId, joinScanId]
    };
    currentRoot = joinId;
  }

  // Add Filter if WHERE exists
  if (parts.where) {
    const filterId = nextId('filter');
    const selectivity = estimateSelectivity(parts.where);
    const parentRows = nodes[currentRoot].estimatedRows;
    nodes[filterId] = {
      id: filterId, op: 'Filter', predicate: parts.where,
      estimatedRows: Math.ceil(parentRows * selectivity),
      children: [currentRoot]
    };
    currentRoot = filterId;
  }

  // Add Aggregate if GROUP BY exists
  if (parts.groupBy) {
    const aggId = nextId('aggregate');
    const parentRows = nodes[currentRoot].estimatedRows;
    nodes[aggId] = {
      id: aggId, op: 'Aggregate', groupBy: parts.groupBy,
      estimatedRows: Math.min(parentRows, 100),
      children: [currentRoot]
    };
    currentRoot = aggId;
  }

  // Add Sort if ORDER BY exists
  if (parts.orderBy) {
    const sortId = nextId('sort');
    const parentRows = nodes[currentRoot].estimatedRows;
    nodes[sortId] = {
      id: sortId, op: 'Sort', orderBy: parts.orderBy,
      estimatedRows: parentRows,
      children: [currentRoot]
    };
    currentRoot = sortId;
  }

  // Add Limit
  if (parts.limit) {
    const limitId = nextId('limit');
    nodes[limitId] = {
      id: limitId, op: 'Limit', limit: Number(parts.limit),
      estimatedRows: Number(parts.limit),
      children: [currentRoot]
    };
    currentRoot = limitId;
  }

  // Add Project
  if (parts.select && parts.select !== '*') {
    const projectId = nextId('project');
    const parentRows = nodes[currentRoot].estimatedRows;
    const columns = parts.select.split(',').map(c => c.trim());
    nodes[projectId] = {
      id: projectId, op: 'Project', columns,
      estimatedRows: parentRows,
      children: [currentRoot]
    };
    currentRoot = projectId;
  }

  return { nodes, root: currentRoot };
}

// ─── Selectivity Estimation ─────────────────────────────────

function estimateSelectivity(predicate: string): number {
  if (!predicate) return 1.0;
  // Each AND condition reduces by a factor
  const conditions = predicate.split(/\band\b/i).length;
  return Math.pow(0.3, conditions);
}

// ─── Rewrite Rules ──────────────────────────────────────────

export function pushDownFilters(tree: PlanTree): PlanTree {
  const nodes = { ...tree.nodes };
  let root = tree.root;

  // Split AND predicates into individual conditions, push each to the correct side
  function pushDown(nodeId: string): string {
    const node = nodes[nodeId];
    if (!node) return nodeId;

    // Recurse into children first
    node.children = node.children.map(pushDown);

    if (node.op === 'Filter' && nodes[node.children[0]]?.op === 'Join') {
      const joinNode = nodes[node.children[0]];
      const predicate = node.predicate || '';

      // Split AND predicates
      const conjuncts = predicate.split(/\s+AND\s+/i).map((s: string) => s.trim()).filter(Boolean);

      const leftTable = nodes[joinNode.leftChild!]?.table ?? '';
      const rightTable = nodes[joinNode.rightChild!]?.table ?? '';

      const leftPreds: string[] = [];
      const rightPreds: string[] = [];
      const remainingPreds: string[] = [];

      for (const pred of conjuncts) {
        const refs = extractColumnRefs(pred);
        const onlyLeft = refs.length === 0 || refs.every(c => c.startsWith(leftTable + '.') || !c.includes('.'));
        const onlyRight = refs.length === 0 || refs.every(c => c.startsWith(rightTable + '.') || !c.includes('.'));

        if (onlyLeft && !onlyRight) {
          leftPreds.push(pred);
        } else if (onlyRight && !onlyLeft) {
          rightPreds.push(pred);
        } else {
          remainingPreds.push(pred);
        }
      }

      let currentRoot = joinNode.id;

      // Push left-side predicates below the join's left child
      if (leftPreds.length > 0 && joinNode.leftChild) {
        const filterId = nextId('filter');
        nodes[filterId] = {
          id: filterId, op: 'Filter', predicate: leftPreds.join(' AND '),
          estimatedRows: Math.ceil(nodes[joinNode.leftChild].estimatedRows * 0.3),
          children: [joinNode.leftChild]
        };
        joinNode.leftChild = filterId;
        joinNode.children = [filterId, joinNode.rightChild!];
        joinNode.estimatedRows = Math.ceil(joinNode.estimatedRows * 0.5);
      }

      // Push right-side predicates below the join's right child
      if (rightPreds.length > 0 && joinNode.rightChild) {
        const filterId = nextId('filter');
        nodes[filterId] = {
          id: filterId, op: 'Filter', predicate: rightPreds.join(' AND '),
          estimatedRows: Math.ceil(nodes[joinNode.rightChild].estimatedRows * 0.3),
          children: [joinNode.rightChild]
        };
        joinNode.rightChild = filterId;
        joinNode.children = [joinNode.leftChild!, filterId];
        joinNode.estimatedRows = Math.ceil(joinNode.estimatedRows * 0.3);
      }

      // If we pushed everything, replace the Filter with the Join
      if (remainingPreds.length === 0) {
        return joinNode.id;
      } else {
        // Keep remaining predicates as a Filter above the Join
        node.predicate = remainingPreds.join(' AND ');
        node.estimatedRows = Math.ceil(joinNode.estimatedRows * 0.3);
      }
    }

    return nodeId;
  }

  root = pushDown(root);
  return { nodes, root };
}

export function foldConstants(tree: PlanTree): PlanTree {
  const nodes = { ...tree.nodes };

  function fold(nodeId: string): void {
    const node = nodes[nodeId];
    if (!node) return;
    node.children.forEach(fold);

    if (node.op === 'Filter' && node.predicate) {
      // Constant-fold arithmetic, but NOT inside string literals or date literals
      const parts = node.predicate.split(/(')/);
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) { // outside quotes
          parts[i] = parts[i]
            .replace(/\b(\d+)\s*\+\s*(\d+)\b/g, (_, a, b) => String(Number(a) + Number(b)))
            .replace(/\b(\d+)\s*\*\s*(\d+)\b/g, (_, a, b) => String(Number(a) * Number(b)));
        }
      }
      node.predicate = parts.join('');
    }
  }

  fold(tree.root);
  return { nodes, root: tree.root };
}

export function pruneUnusedColumns(tree: PlanTree): PlanTree {
  // Collect all referenced columns from predicates, GROUP BY, ORDER BY
  const nodes = { ...tree.nodes };
  const required = new Set<string>();

  function collectRefs(nodeId: string): void {
    const node = nodes[nodeId];
    if (!node) return;
    if (node.predicate) extractColumnRefs(node.predicate).forEach(c => required.add(c));
    if (node.groupBy) extractColumnRefs(node.groupBy).forEach(c => required.add(c));
    if (node.orderBy) extractColumnRefs(node.orderBy).forEach(c => required.add(c));
    if (node.columns) node.columns.forEach(c => required.add(c));
    node.children.forEach(collectRefs);
  }

  collectRefs(tree.root);

  // Prune Project nodes
  function prune(nodeId: string): void {
    const node = nodes[nodeId];
    if (!node) return;
    node.children.forEach(prune);
    if (node.op === 'Project' && node.columns) {
      node.columns = node.columns.filter(c => required.has(c) || c === '*');
      if (node.columns!.length === 0) node.columns = ['*'];
    }
  }

  prune(tree.root);
  return { nodes, root: tree.root };
}

function extractColumnRefs(expr: string): string[] {
  const refs: string[] = [];
  const sqlKw = new Set(['select','from','where','and','or','not','join','inner','left','right',
    'full','on','as','is','null','in','between','like','order','by','group','limit',
    'having','distinct','asc','desc','count','sum','avg','min','max','true','false']);
  const matches = expr.matchAll(/\b(\w+)\.(\w+)\b/g);
  for (const m of matches) {
    const ref = `${m[1]}.${m[2]}`;
    if (!sqlKw.has(m[1].toLowerCase()) && !sqlKw.has(m[2].toLowerCase())) {
      refs.push(ref);
    }
  }
  return [...new Set(refs)];
}

// ─── Physical Plan Selection ────────────────────────────────

export function choosePhysicalOperators(tree: PlanTree, stats: Record<string, TableStats>): PlanTree {
  const nodes = { ...tree.nodes };

  function choose(nodeId: string): void {
    const node = nodes[nodeId];
    if (!node) return;
    node.children.forEach(choose);

    // Choose join algorithm based on input sizes
    if (node.op === 'Join' && node.leftChild && node.rightChild) {
      const leftRows = nodes[node.leftChild]?.estimatedRows ?? 1000;
      const rightRows = nodes[node.rightChild]?.estimatedRows ?? 1000;

      if (leftRows > 10000 || rightRows > 10000) {
        node.joinType = 'hash';
      } else if (leftRows < 100 && rightRows < 100) {
        node.joinType = 'nested_loop';
      } else {
        node.joinType = 'hash';
      }
    }

    // Choose index scan for large tables with filters
    if (node.op === 'Scan' && node.table) {
      const parent = Object.values(nodes).find(n => n.children.includes(nodeId));
      if (parent?.op === 'Filter') {
        const tableStats = stats[node.table];
        if (tableStats && tableStats.rowCount > 10000) {
          // Mark as index scan
          node.table = node.table + ' /* index_scan */';
        }
      }
    }
  }

  choose(tree.root);
  return { nodes, root: tree.root };
}

// ─── Cost Estimation ───────────────────────────────────────

export function estimateCost(nodes: Record<string, PlanNode>, rootId: string): number {
  const node = nodes[rootId];
  if (!node) return 0;

  const childCosts = node.children.reduce((sum, c) => sum + estimateCost(nodes, c), 0);
  let selfCost = 0;

  switch (node.op) {
    case 'Scan':
      selfCost = node.estimatedRows;
      break;
    case 'Filter':
      selfCost = Math.ceil(node.estimatedRows * 0.01);
      break;
    case 'Join': {
      const leftRows = node.leftChild ? (nodes[node.leftChild]?.estimatedRows ?? 1000) : 1000;
      const rightRows = node.rightChild ? (nodes[node.rightChild]?.estimatedRows ?? 1000) : 1000;
      if (node.joinType === 'hash') {
        selfCost = leftRows + rightRows + Math.ceil(leftRows * 0.5);
      } else if (node.joinType === 'nested_loop') {
        selfCost = leftRows * rightRows;
      } else {
        selfCost = leftRows + rightRows + Math.ceil(leftRows * 0.3);
      }
      break;
    }
    case 'Aggregate':
      selfCost = Math.ceil(node.estimatedRows * 0.5);
      break;
    case 'Sort':
      selfCost = Math.ceil(node.estimatedRows * Math.log2(Math.max(node.estimatedRows, 2)));
      break;
    case 'Project':
      selfCost = Math.ceil(node.estimatedRows * 0.001);
      break;
    case 'Limit':
      selfCost = 1;
      break;
    default:
      selfCost = node.estimatedRows;
  }

  return childCosts + selfCost;
}

// ─── SQL Generation ────────────────────────────────────────

export function generateSQL(nodes: Record<string, PlanNode>, rootId: string): string {
  let select = '*';
  const fromTables: string[] = [];
  const joins: string[] = [];
  let where = '';
  let groupBy = '';
  let orderBy = '';
  let limit = '';

  // Pass 1: collect which tables appear in JOINs, and identify the leftmost table
  // The leftmost table goes in FROM; everything else appears via JOIN
  const joinedAsRight = new Set<string>();  // tables on the right side of a JOIN
  const leftmostJoinTable = new Set<string>();  // tables on the left side of a JOIN
  function collectJoinTables(nid: string): void {
    const n = nodes[nid];
    if (!n) return;
    n.children.forEach(collectJoinTables);
    if (n.op === 'Join') {
      if (n.rightChild) {
        let cur = n.rightChild;
        while (nodes[cur] && !nodes[cur].table && nodes[cur].children.length > 0) cur = nodes[cur].children[0];
        if (nodes[cur]?.table) joinedAsRight.add(nodes[cur].table.replace(/ \/\*.*\*\//, ''));
      }
      if (n.leftChild) {
        let cur = n.leftChild;
        while (nodes[cur] && !nodes[cur].table && nodes[cur].children.length > 0) cur = nodes[cur].children[0];
        if (nodes[cur]?.table) leftmostJoinTable.add(nodes[cur].table.replace(/ \/\*.*\*\//, ''));
      }
    }
  }
  collectJoinTables(rootId);

  // Pass 2: generate SQL
  function walk(nid: string): void {
    const n = nodes[nid];
    if (!n) return;

    switch (n.op) {
      case 'Scan':
        if (n.table) {
          const cleanName = n.table.replace(/ \/\*.*\*\//, '');
          // Only add to FROM if not appearing as right side of a JOIN
          if (!joinedAsRight.has(cleanName)) {
            fromTables.push(cleanName);
          }
        }
        break;
      case 'Filter':
        if (where) {
          where = `(${where}) AND (${n.predicate})`;
        } else {
          where = n.predicate ?? '';
        }
        break;
      case 'Join': {
        const jt = n.joinType === 'hash' ? 'INNER' : n.joinType === 'nested_loop' ? 'INNER' : (n.joinType?.toUpperCase() ?? 'INNER');
        const resolveTable = (nid: string | undefined): string => {
          if (!nid) return 'unknown';
          const nd = nodes[nid];
          if (!nd) return 'unknown';
          if (nd.table) return nd.table.replace(/ \/\*.*\*\//, '');
          for (const cid of nd.children) {
            const t = resolveTable(cid);
            if (t !== 'unknown') return t;
          }
          return 'unknown';
        };
        const rt = resolveTable(n.rightChild);
        const lt = resolveTable(n.leftChild);
        const onClause = n.onClause ?? `${rt}.id = ${lt}.id`;
        joins.push(`${jt} JOIN ${rt} ON ${onClause}`);
        if (n.leftChild) walk(n.leftChild);
        if (n.rightChild) walk(n.rightChild);
        return;
      }
      case 'Aggregate':
        if (n.groupBy) {
          select = `${n.groupBy}, COUNT(*)`;
          groupBy = n.groupBy;
        } else {
          select = 'COUNT(*)';
        }
        break;
      case 'Sort':
        orderBy = n.orderBy ?? '';
        break;
      case 'Project':
        if (n.columns && n.columns.length > 0 && !n.columns.includes('*')) {
          select = n.columns.join(', ');
        }
        break;
      case 'Limit':
        limit = String(n.limit ?? '');
        break;
    }
    n.children.forEach(walk);
  }

  walk(rootId);

  let sql = `SELECT ${select} FROM ${[...new Set(fromTables)].join(', ')}`;
  if (joins.length > 0) sql += ' ' + joins.join(' ');
  if (where) sql += ` WHERE ${where}`;
  if (groupBy) sql += ` GROUP BY ${groupBy}`;
  if (orderBy) sql += ` ORDER BY ${orderBy}`;
  if (limit) sql += ` LIMIT ${limit}`;
  return sql + ';';
}

// ─── Utility ───────────────────────────────────────────────

export function stringOfPlan(nodes: Record<string, PlanNode>, rootId: string, indent: number = 0): string {
  const node = nodes[rootId];
  if (!node) return '';
  const prefix = '  '.repeat(indent);
  let line = `${prefix}${node.op}`;
  if (node.table) line += ` [${node.table}]`;
  if (node.predicate) line += ` {${node.predicate}}`;
  if (node.joinType) line += ` (${node.joinType})`;
  line += ` rows=${node.estimatedRows}`;

  const children = node.children.map(c => stringOfPlan(nodes, c, indent + 1)).filter(Boolean);
  return [line, ...children].join('\n');
}

// ─── Sample Statistics ──────────────────────────────────────

export const sampleStats: Record<string, TableStats> = {
  users: {
    rowCount: 100000,
    columns: {
      id: { ndv: 100000, nullFraction: 0, avgWidth: 4 },
      name: { ndv: 95000, nullFraction: 0.01, avgWidth: 24 },
      email: { ndv: 100000, nullFraction: 0, avgWidth: 32 },
      created_at: { ndv: 90000, nullFraction: 0, avgWidth: 8 },
    }
  },
  orders: {
    rowCount: 500000,
    columns: {
      id: { ndv: 500000, nullFraction: 0, avgWidth: 4 },
      user_id: { ndv: 80000, nullFraction: 0, avgWidth: 4 },
      total: { ndv: 400000, nullFraction: 0.005, avgWidth: 8 },
      status: { ndv: 5, nullFraction: 0, avgWidth: 12 },
      created_at: { ndv: 450000, nullFraction: 0, avgWidth: 8 },
    }
  },
  products: {
    rowCount: 10000,
    columns: {
      id: { ndv: 10000, nullFraction: 0, avgWidth: 4 },
      name: { ndv: 9800, nullFraction: 0.01, avgWidth: 48 },
      price: { ndv: 8500, nullFraction: 0, avgWidth: 8 },
      category: { ndv: 50, nullFraction: 0, avgWidth: 24 },
    }
  },
  order_items: {
    rowCount: 1500000,
    columns: {
      id: { ndv: 1500000, nullFraction: 0, avgWidth: 4 },
      order_id: { ndv: 500000, nullFraction: 0, avgWidth: 4 },
      product_id: { ndv: 10000, nullFraction: 0, avgWidth: 4 },
      quantity: { ndv: 20, nullFraction: 0, avgWidth: 4 },
      price: { ndv: 5000, nullFraction: 0, avgWidth: 8 },
    }
  }
};

// ─── Demo ───────────────────────────────────────────────────

export function demo(): void {
  const sql = "SELECT users.name, COUNT(*) FROM users INNER JOIN orders ON users.id = orders.user_id WHERE users.created_at > '2024-01-01' AND orders.status = 'active' GROUP BY users.name ORDER BY COUNT(*) DESC LIMIT 10";

  console.log('=== SQL Query Optimizer Demo ===\n');
  console.log('Input SQL:');
  console.log(sql);
  console.log();

  // Parse
  const initialPlan = buildInitialPlan(sql, sampleStats);
  console.log('Initial Plan:');
  console.log(stringOfPlan(initialPlan.nodes, initialPlan.root));
  const initialCost = estimateCost(initialPlan.nodes, initialPlan.root);
  console.log(`Initial Cost: ${initialCost}\n`);

  // Rewrite: push down filters
  const afterPushDown = pushDownFilters(initialPlan);
  console.log('After Predicate Pushdown:');
  console.log(stringOfPlan(afterPushDown.nodes, afterPushDown.root));
  const pushDownCost = estimateCost(afterPushDown.nodes, afterPushDown.root);
  console.log(`Cost after pushdown: ${pushDownCost}\n`);

  // Rewrite: fold constants
  const afterFold = foldConstants(afterPushDown);
  console.log('After Constant Folding:');
  console.log(stringOfPlan(afterFold.nodes, afterFold.root));
  const foldCost = estimateCost(afterFold.nodes, afterFold.root);
  console.log(`Cost after folding: ${foldCost}\n`);

  // Physical plan
  const physicalPlan = choosePhysicalOperators(afterFold, sampleStats);
  console.log('Physical Plan:');
  console.log(stringOfPlan(physicalPlan.nodes, physicalPlan.root));
  const physicalCost = estimateCost(physicalPlan.nodes, physicalPlan.root);
  console.log(`Physical Cost: ${physicalCost}\n`);

  // Generate optimized SQL
  const optimizedSQL = generateSQL(physicalPlan.nodes, physicalPlan.root);
  console.log('Optimized SQL:');
  console.log(optimizedSQL);
  console.log();

  console.log('=== Summary ===');
  console.log(`Initial cost: ${initialCost}`);
  console.log(`Final cost:   ${physicalCost}`);
  console.log(`Improvement:   ${((1 - physicalCost / initialCost) * 100).toFixed(1)}%`);
}