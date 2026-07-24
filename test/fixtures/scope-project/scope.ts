export function outer() {
	function helper() {
		return 1;
	}
	return helper();
}

function helper() {
	return 2;
}

export function other() {
	return helper();
}
