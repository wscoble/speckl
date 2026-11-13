# Camel contract class

A domain that has a consumes list, a produces list, or a budget becomes a comment and an empty `NameContract` class. The class body is a private constructor. The class has no runtime method. A speck with no domain emits no contract class. A domain with no contract clauses emits no contract class. The contract class does not throttle, queue, or route messages. The Camel target still emits a RouteBuilder for the speck's actions. This class does not run a tick and does not call Z3. The comment says the compiler checks the budget with Z3 before deploy when the tick can be lowered.

`compiler/src/__tests__/domain-contracts.test.ts` covers `emits a comment block and a typed event class, and does not throttle`, `does not emit a contract class when the speck has no domain`, and `emits an empty contract class and does not add a runtime method`.
