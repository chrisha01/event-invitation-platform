// Copy this file to backend.mjs when the production backend is ready.
// The backend agent owns the application logic and should implement this adapter:
//
// export async function createHandler({ sql, env }) {
//   return async (event, context) => ({
//     statusCode: 200,
//     body: JSON.stringify({ ok: true })
//   });
// }
//
// Keep SQL access on the server, use parameterized queries, and do not use the
// local v0.1 SQLite file in a Function.
