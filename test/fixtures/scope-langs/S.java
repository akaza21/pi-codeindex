class C {
	int a() { return b(); }
	int b() { return 1; }
}

class D {
	int b() { return 2; }
}
