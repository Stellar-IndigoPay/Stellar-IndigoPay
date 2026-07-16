"use strict";

const { verifyMagicBytes } = require("../../middleware/magicBytes");

describe("magicBytes middleware", () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = { file: {} };
    res = {};
    next = jest.fn();
  });

  it("should pass if no file is present", () => {
    req.file = undefined;
    verifyMagicBytes(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("should pass PDF with correct magic bytes", () => {
    req.file.mimetype = "application/pdf";
    req.file.buffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x01, 0x02]);
    verifyMagicBytes(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("should fail PDF with incorrect magic bytes", () => {
    req.file.mimetype = "application/pdf";
    req.file.buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x01, 0x02]);
    verifyMagicBytes(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: "VALIDATION_ERROR",
      metadata: expect.objectContaining({ code: "MIME_MISMATCH" })
    }));
  });

  it("should pass PNG with correct magic bytes", () => {
    req.file.mimetype = "image/png";
    req.file.buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    verifyMagicBytes(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("should pass ZIP/DOCX with correct magic bytes", () => {
    req.file.mimetype = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    req.file.buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    verifyMagicBytes(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("should pass unknown text types without checking", () => {
    req.file.mimetype = "text/csv";
    req.file.buffer = Buffer.from("a,b,c\n1,2,3");
    verifyMagicBytes(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });
});
