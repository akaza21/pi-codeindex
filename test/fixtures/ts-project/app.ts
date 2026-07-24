import { add, square } from "./math.ts";

export class Calculator {
	total = 0;

	accumulate(n: number): void {
		this.total = add(this.total, square(n));
	}
}

export function run(): number {
	const calc = new Calculator();
	calc.accumulate(3);
	return calc.total;
}
