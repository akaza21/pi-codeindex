import type { Clock } from "../ports.ts";

export class SystemClock implements Clock {
	now(): number {
		return Date.now();
	}

	isoNow(): string {
		return new Date().toISOString();
	}
}
