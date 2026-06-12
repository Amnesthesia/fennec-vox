import { describe, expect, it, vi } from "vitest";
import { pLimit } from "../pLimit";

describe("pLimit", () => {
	it("resolves an empty array immediately", async () => {
		const result = await pLimit([], 2);
		expect(result).toEqual([]);
	});

	it("runs all tasks and preserves order", async () => {
		const tasks = [1, 2, 3].map((n) => async () => n * 10);
		expect(await pLimit(tasks, 2)).toEqual([10, 20, 30]);
	});

	it("respects concurrency limit", async () => {
		let active = 0;
		let maxActive = 0;
		const tasks = Array.from({ length: 6 }, () => async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 10));
			active--;
			return active;
		});
		await pLimit(tasks, 2);
		expect(maxActive).toBe(2);
	});

	it("rejects if any task throws", async () => {
		const tasks = [
			async () => 1,
			async () => {
				throw new Error("boom");
			},
			async () => 3,
		];
		await expect(pLimit(tasks, 2)).rejects.toThrow("boom");
	});

	it("runs limit=1 sequentially", async () => {
		const order: number[] = [];
		const tasks = [1, 2, 3].map((n) => async () => {
			order.push(n);
			return n;
		});
		const result = await pLimit(tasks, 1);
		expect(result).toEqual([1, 2, 3]);
		expect(order).toEqual([1, 2, 3]);
	});

	it("handles concurrency larger than task count", async () => {
		const tasks = [async () => "a", async () => "b"];
		expect(await pLimit(tasks, 100)).toEqual(["a", "b"]);
	});

	it("allows async side effects with promise.all semantics", async () => {
		const spy = vi.fn();
		const tasks = [1, 2, 3].map((n) => async () => {
			spy(n);
			return n;
		});
		await pLimit(tasks, 3);
		expect(spy).toHaveBeenCalledTimes(3);
	});
});
