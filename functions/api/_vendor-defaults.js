// SOARD's minimums for a trade partner's papers until someone changes them (Admin → Job Costs →
// W-9s & insurance). On their own so a page that only shows them doesn't load the vendor engine.
// asking: whether vendors and their agents are emailed for a W-9 or certificate at all (off until someone at SOARD turns it on)
export const DEFAULTS = { glOccurrence: 1000000, glAggregate: 2000000, workersComp: true, elEachAccident: 100000, renewDays: 30, asking: false };
