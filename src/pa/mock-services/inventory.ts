import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function inventoryRoutes(load: FixtureLoader): Router {
	const r = Router();
	const products = (): any[] => load("inventory/products.json");

	r.post("/inventory/products", (req, res) => {
		const all = products();
		const { category } = req.body;
		const filtered = category
			? all.filter((p) => p.category === category)
			: all;
		res.json({ total: filtered.length, products: filtered });
	});

	r.post("/inventory/products/get", (req, res) => {
		const { product_id } = req.body;
		if (!product_id) return res.json({ error: "product_id required" });
		const p = products().find((p) => p.product_id === product_id);
		if (!p) return res.status(404).json({ error: "product not found" });
		res.json(p);
	});

	r.post("/inventory/orders/create", (req, res) => {
		console.log("[mock-inventory] order:", req.body.product_id);
		res.json({ success: true, order_id: `ORD-${Date.now()}` });
	});

	return r;
}
