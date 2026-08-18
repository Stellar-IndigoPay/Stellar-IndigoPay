declare const require: (id: string) => unknown;
declare const __dirname: string;

type ReadFileSync = (path: string, encoding: "utf8") => string;

const { readFileSync } = require("node:fs") as {
  readFileSync: ReadFileSync;
};
const { join } = require("node:path") as {
  join: (...segments: string[]) => string;
};

const EXPECTED_EXTENSION_PAGES_CSP = "script-src 'self'; object-src 'none';";
const MANIFEST_FILES = ["manifest.json", "manifest.firefox.json"];

describe("extension manifest content security policy", () => {
  test.each(MANIFEST_FILES)("%s declares a restrictive extension page CSP", (fileName) => {
    const manifestPath = join(__dirname, "..", "..", fileName);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      content_security_policy?: {
        extension_pages?: string;
      };
    };

    expect(manifest.content_security_policy).toEqual({
      extension_pages: EXPECTED_EXTENSION_PAGES_CSP,
    });
    expect(manifest.content_security_policy?.extension_pages).not.toContain(
      "'unsafe-inline'",
    );
    expect(manifest.content_security_policy?.extension_pages).not.toContain(
      "'unsafe-eval'",
    );
  });
});
