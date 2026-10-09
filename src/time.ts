
// Session ids are the timestamp of when the session started (see formatSessionDate).
export const newSessionId = () => String(Date.now());

// Edit times for sync. Kept outside the component so render stays pure.
export const nowMs = () => Date.now();
