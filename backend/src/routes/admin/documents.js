/**
 * src/routes/admin/documents.js — Admin document integrity verification
 *
 * Verification supporting documents pinned to IPFS are content-addressed:
 * the CID stored in verification_requests.supporting_documents is a
 * cryptographic fingerprint of the file. This router lets an admin
 * re-download a document from the IPFS gateway and confirm it is still
 * retrievable and untampered before approving a project.
 *
 * Public surface (mounted at /api/admin/documents):
 *   - GET /:cid/verify?name=<fileName>&sha256=<hex>
 *       Re-fetches ipfs://<cid> through the configured gateway, computes
 *       the SHA-256 of the retrieved bytes, and (when ?sha256= is given)
 *       compares it against the fingerprint recorded at submission time.
 *       Responds { success: true, data: { valid, cid, hash, size, matches? } }.
 *
 * Admin auth follows the same adminRequired middleware as the rest of
 * the admin surface (Bearer JWT from /api/admin/login or X-Admin-Key).
 */
"use strict";

const express = require("express");
const router = express.Router();
const { adminRequired } = require("../../middleware/auth");
const { logAdminAction } = require("../../services/audit");
const { verifyIPFSDocument } = require("../../services/storage");
const { AppError } = require("../../errors");

async function verifyDocumentHandler(req, res, next) {
  try {
    const { cid } = req.params;
    const fileName =
      typeof req.query.name === "string" && req.query.name.trim()
        ? req.query.name.trim()
        : undefined;
    const expectedSha256 =
      typeof req.query.sha256 === "string" && /^[a-fA-F0-9]{64}$/.test(req.query.sha256)
        ? req.query.sha256
        : undefined;

    const result = await verifyIPFSDocument(cid, { fileName, expectedSha256 });

    logAdminAction({
      actor: (req.admin && req.admin.sub) || "admin",
      action: "document.verify",
      targetType: "ipfs_document",
      targetId: cid,
      metadata: { valid: result.valid, fileName: fileName || null },
      ipAddress: req.ip,
    });

    if (result.error === "Invalid CID") {
      throw new AppError("VALIDATION_ERROR", { field: "cid", detail: "Invalid CID" });
    }
    res.json({ success: true, data: result });
  } catch (e) {
    next(e);
  }
}

// GET /api/admin/documents/:cid/verify
router.get("/:cid/verify", adminRequired, verifyDocumentHandler);
// Compatibility with the alternate shape in the issue details.
router.get("/verify/:cid", adminRequired, verifyDocumentHandler);

module.exports = router;
