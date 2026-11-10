/**
 * Tests configure the server through the legacy VAULT_ names (which must keep working). A CROSSDRIVE_ variable
 * exported in the developer's shell or in CI would take precedence over them, so drop those before every test file.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CROSSDRIVE_")) delete process.env[key];
}
