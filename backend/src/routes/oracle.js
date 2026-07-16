const express = require("express");
const router = express.Router();
const oracleService = require("../services/oracleService");

router.get("/price", (req, res) => {
  res.json({
    success: true,
    data: {
      price: oracleService.getCurrentPrice(),
      updatedAt: oracleService.getLastUpdateTime(),
      source: "stellar-dex",
    },
  });
});

module.exports = router;
