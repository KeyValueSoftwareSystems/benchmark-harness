import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function sheetRoutes(load: FixtureLoader): Router {
	const r = Router();
	const workbooks = (): any[] => load("sheet/workbooks.json");

	r.post("/sheet/workbooks", (req, res) => {
		res.json({ total: workbooks().length, workbooks: workbooks() });
	});

	r.post("/sheet/open", (req, res) => {
		const { workbook_id } = req.body;
		if (!workbook_id) return res.json({ error: "workbook_id required" });
		const wb = workbooks().find((w) => w.workbook_id === workbook_id || w.id === workbook_id);
		if (!wb) return res.status(404).json({ error: "workbook not found" });
		res.json(wb);
	});

	r.post("/sheet/create_workbook", (req, res) => {
		console.log("[mock-sheet] create workbook:", req.body.name);
		res.json({ success: true, workbook_id: `WB-${Date.now()}` });
	});

	r.post("/sheet/delete_workbook", (req, res) => {
		console.log("[mock-sheet] delete workbook:", req.body.workbook_id);
		res.json({ success: true });
	});

	r.post("/sheet/add_sheet", (req, res) => {
		console.log("[mock-sheet] add sheet:", req.body.name);
		res.json({ success: true });
	});

	r.post("/sheet/delete_sheet", (req, res) => {
		console.log("[mock-sheet] delete sheet:", req.body.sheet_name);
		res.json({ success: true });
	});

	r.post("/sheet/rename_sheet", (req, res) => {
		console.log("[mock-sheet] rename sheet:", req.body.old_name, "→", req.body.new_name);
		res.json({ success: true });
	});

	r.post("/sheet/get_range", (req, res) => {
		const { workbook_id } = req.body;
		if (!workbook_id) return res.json({ error: "workbook_id required" });
		res.json({ values: [] });
	});

	r.post("/sheet/set_range", (req, res) => {
		console.log("[mock-sheet] set range");
		res.json({ success: true });
	});

	r.post("/sheet/set_cell", (req, res) => {
		console.log("[mock-sheet] set cell");
		res.json({ success: true });
	});

	r.post("/sheet/insert_row", (req, res) => {
		console.log("[mock-sheet] insert row");
		res.json({ success: true });
	});

	r.post("/sheet/compute", (req, res) => {
		const { formula } = req.body;
		if (!formula) return res.json({ error: "formula required" });
		res.json({ result: 0 });
	});

	return r;
}
