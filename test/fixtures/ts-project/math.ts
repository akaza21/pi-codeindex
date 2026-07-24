export function add(a: number, b: number): number {
	return a + b;
}

export function square(n: number): number {
	return add(n, 0) + multiply(n, n);
}

function multiply(a: number, b: number): number {
	return a * b;
}
