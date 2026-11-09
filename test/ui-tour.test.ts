import assert from "node:assert/strict";
import test from "node:test";
import { TOUR_STEPS, tourDone, tourDoneCookie } from "../src/ui/tour.js";

test("the tour counts as done only when its cookie says so", () => {
	assert.equal(tourDone(""), false);
	assert.equal(tourDone("a=1; b=2"), false);
	assert.equal(tourDone("a=1; smithy-tour=done; b=2"), true);
	assert.equal(tourDone("smithy-tour=done"), true);
	assert.equal(tourDone("smithy-tour=skipped"), false);
	assert.equal(tourDone("not-smithy-tour=done"), false);
});

test("the cookie lasts a year, applies site-wide and is not sent cross-site", () => {
	const c = tourDoneCookie();
	assert.match(c, /^smithy-tour=done;/);
	assert.match(c, /max-age=31536000/);
	assert.match(c, /path=\//);
	assert.match(c, /SameSite=Lax/);
});

test("every tour step points at an element and says something", () => {
	assert.ok(TOUR_STEPS.length >= 4);
	for (const step of TOUR_STEPS) {
		assert.match(step.target, /^[#.][\w-]+$/);
		assert.ok(step.title.length > 0 && step.text.length > 0);
	}
});
