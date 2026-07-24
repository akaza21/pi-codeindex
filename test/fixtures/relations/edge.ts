class Box<T> { get(): T { return null as unknown as T; } }
export class StringBox extends Box<string> {}
interface IA { a(): void }
interface IB { b(): void }
interface IC extends IA, IB {}
class Plain {}
namespace NS { export class NsBase {} }
class Q extends NS.NsBase {}
function makeInner() { class Inner extends Box<number> {} return Inner; }
function wrap<T>(x: T): T { return x; }
class Mixed extends (wrap(Box)) {}
namespace Out { export namespace In { export class Deep {} } }
class DeepSub extends Out.In.Deep {}
