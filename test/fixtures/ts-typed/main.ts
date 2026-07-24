import { A } from "./a.ts";
import { B } from "./b.ts";

export function useA() {
	const a = new A();
	return a.run();
}

export function useB() {
	const b = new B();
	return b.run();
}
