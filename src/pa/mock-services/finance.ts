import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function financeRoutes(load: FixtureLoader): Router {
	const r = Router();
	const txns = (): any[] => load("finance/transactions.json");

	r.post("/finance/transactions", (req, res) => {
		const all = txns();
		const { start_date, end_date } = req.body;
		let filtered = all;
		if (start_date || end_date) {
			filtered = all.filter((t) => {
				const d = t.date;
				if (start_date && d < start_date) return false;
				if (end_date && d > end_date) return false;
				return true;
			});
		}
		res.json({ total: filtered.length, transactions: filtered });
	});

	r.post("/finance/transactions/get", (req, res) => {
		const { transaction_id } = req.body;
		if (!transaction_id) return res.json({ error: "transaction_id required" });
		const t = txns().find((t) => t.transaction_id === transaction_id);
		if (!t) return res.status(404).json({ error: "transaction not found" });
		res.json(t);
	});

	r.post("/finance/report/submit", (req, res) => {
		console.log("[mock-finance] report submitted");
		res.json({ success: true, report_id: `RPT-${Date.now()}` });
	});

	return r;
}
