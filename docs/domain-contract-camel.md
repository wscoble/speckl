# Camel contract class

A domain becomes a comment and an empty `NameContract` class with a private constructor. The class has no runtime method. A speck with no domain emits no contract class. Camel does not throttle, queue, or route, and it does not run a tick. It does not call Z3.

`compiler/src/__tests__/domain-contracts.test.ts` covers `emits a comment block and a typed event class, and does not throttle`, `does not emit a contract class when the speck has no domain`, and `emits an empty contract class and does not add a runtime method`.
