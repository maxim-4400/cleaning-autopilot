// Vitest runs server modules in Node. Next.js enforces the real `server-only`
// marker during application bundling; this test-only shim keeps unit imports
// executable without weakening production module boundaries.
export {};
