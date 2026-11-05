import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function crmRoutes(load: FixtureLoader): Router {
	const r = Router();
	const customers = (): any[] => load("crm/customers.json");

	r.post("/crm/customers", (req, res) => {
		const all = customers();
		const { status, tier, industry } = req.body;
		let filtered = all;
		if (status) filtered = filtered.filter((c) => c.status === status);
		if (tier) filtered = filtered.filter((c) => c.tier === tier);
		if (industry) filtered = filtered.filter((c) => c.industry === industry);
		res.json({
			total: filtered.length,
			customers: filtered.map(({ notes: _, contracts: __, ...rest }) => rest),
		});
	});

	r.post("/crm/customers/get", (req, res) => {
		const { customer_id } = req.body;
		if (!customer_id) return res.json({ error: "customer_id required" });
		const c = customers().find((c) => c.customer_id === customer_id);
		if (!c) return res.status(404).json({ error: "customer not found" });
		res.json(c);
	});

	return r;
}
