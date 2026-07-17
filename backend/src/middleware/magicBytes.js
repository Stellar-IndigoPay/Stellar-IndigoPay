"use strict";

const { AppError } = require("../errors");

const MAGIC_BYTES = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff],
  zip: [0x50, 0x4b, 0x03, 0x04], // PK\x03\x04
  gif: [0x47, 0x49, 0x46, 0x38], // GIF8
  ole: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] // Older .doc / .xls
};

function checkMagicBytes(buffer, magicBytes, offset = 0) {
  if (buffer.length < offset + magicBytes.length) return false;
  for (let i = 0; i < magicBytes.length; i++) {
    if (buffer[offset + i] !== magicBytes[i]) return false;
  }
  return true;
}

function verifyMagicBytes(req, res, next) {
  if (!req.file || !req.file.buffer) {
    return next(); // handled by validation later
  }

  const { mimetype, buffer } = req.file;

  let isValid = true;

  if (mimetype === "application/pdf") {
    isValid = checkMagicBytes(buffer, MAGIC_BYTES.pdf);
  } else if (mimetype === "image/png") {
    isValid = checkMagicBytes(buffer, MAGIC_BYTES.png);
  } else if (mimetype === "image/jpeg") {
    isValid = checkMagicBytes(buffer, MAGIC_BYTES.jpeg);
  } else if (mimetype === "image/gif") {
    isValid = checkMagicBytes(buffer, MAGIC_BYTES.gif);
  } else if (mimetype === "image/webp") {
    // RIFF at 0, WEBP at 8
    const isRiff = checkMagicBytes(buffer, [0x52, 0x49, 0x46, 0x46], 0);
    const isWebp = checkMagicBytes(buffer, [0x57, 0x45, 0x42, 0x50], 8);
    isValid = isRiff && isWebp;
  } else if (
    mimetype === "application/zip" ||
    mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    isValid = checkMagicBytes(buffer, MAGIC_BYTES.zip);
  } else if (
    mimetype === "application/msword" ||
    mimetype === "application/vnd.ms-excel"
  ) {
    // Allow both ZIP (some systems send docx as msword) and OLE formats just to be safe
    isValid = checkMagicBytes(buffer, MAGIC_BYTES.zip) || checkMagicBytes(buffer, MAGIC_BYTES.ole);
  }

  // Text / CSV formats do not have reliable magic bytes so we skip them here.
  
  if (!isValid) {
    return next(
      new AppError("VALIDATION_ERROR", {
        detail: "File content does not match declared MIME type",
        code: "MIME_MISMATCH"
      })
    );
  }

  next();
}

module.exports = {
  verifyMagicBytes,
  checkMagicBytes,
};
