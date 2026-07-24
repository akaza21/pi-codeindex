import { DA, DB } from "./ifaces";
export class Widget implements DA, DB {
  render() { this.paint(); }
}
