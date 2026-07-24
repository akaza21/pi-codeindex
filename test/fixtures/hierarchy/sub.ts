import { Base } from "./base";
export class Sub extends Base {
  run() { this.greet(); }
  own() {}
  useOwn() { this.own(); }
  pingCaller() { this.ping(); }
}
