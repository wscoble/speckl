import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMsg } from './ollama.ts';

export interface SessionMeta {
  id: string;
  title: string;
  created: string;
  updated: string;
  /** last spec opened in this session - auto-reopened on load */
  lastSpec?: string;
}

export class Sessions {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private dir(id: string) {
    return join(this.root, id);
  }

  async create(title?: string): Promise<SessionMeta> {
    const id = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 6);
    const meta: SessionMeta = { id, title: title ?? 'New conversation', created: new Date().toISOString(), updated: new Date().toISOString() };
    await mkdir(join(this.dir(id), 'specs'), { recursive: true });
    await mkdir(join(this.dir(id), 'out'), { recursive: true });
    await this.saveMeta(meta);
    await this.saveMessages(id, []);
    return meta;
  }

  async list(): Promise<SessionMeta[]> {
    try {
      const ids = (await readdir(this.root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
      const metas = await Promise.all(ids.map(async (id) => this.loadMeta(id).catch(() => null)));
      return metas.filter((m): m is SessionMeta => m !== null).sort((a, b) => b.updated.localeCompare(a.updated));
    } catch {
      return [];
    }
  }

  async loadMeta(id: string): Promise<SessionMeta> {
    return JSON.parse(await readFile(join(this.dir(id), 'meta.json'), 'utf8'));
  }

  private async saveMeta(meta: SessionMeta) {
    await writeFile(join(this.dir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2));
  }

  async touch(id: string, title?: string) {
    const meta = await this.loadMeta(id);
    meta.updated = new Date().toISOString();
    if (title && (meta.title === 'New conversation' || title.startsWith('New conversation'))) meta.title = title;
    else if (title) meta.title = title;
    await this.saveMeta(meta);
    return meta;
  }

  async setLastSpec(id: string, name: string) {
    const meta = await this.loadMeta(id);
    meta.lastSpec = name;
    await this.saveMeta(meta);
    return meta;
  }

  async messages(id: string): Promise<ChatMsg[]> {
    try {
      return JSON.parse(await readFile(join(this.dir(id), 'messages.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  async saveMessages(id: string, messages: ChatMsg[]) {
    await writeFile(join(this.dir(id), 'messages.json'), JSON.stringify(messages, null, 2));
  }

  async exists(id: string): Promise<boolean> {
    try {
      await this.loadMeta(id);
      return true;
    } catch {
      return false;
    }
  }
}