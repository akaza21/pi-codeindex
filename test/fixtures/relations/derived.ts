import { Base } from "./base";
import type { Greeter } from "./base";
export class Derived extends Base implements Greeter { greet() {} }
