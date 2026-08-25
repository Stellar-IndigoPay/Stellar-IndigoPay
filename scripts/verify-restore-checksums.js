#!/usr/bin/env node

/**
 * Verify restore integrity using row-level checksums.
 * This script compares checksums generated before backup with checksums
 * generated after restore to detect silent data corruption.
 * 
 * Usage: node scripts/verify-restore-checksums.js --host <host> --port <port> --user <user> --database <db> --checksums <checksums.json>
 */

const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace('--', '');
  options[key] = args[i + 1];
}

const required = ['host', 'port', 'user', 'database', 'checksums'];
for (const req of required) {
  if (!options[req]) {
    console.error(`Missing required argument: --${req}`);
    process.exit(1);
  }
}

async function verifyChecksums() {
  const pool = new Pool({
    host: options.host,
    port: parseInt(options.port),
    user: options.user,
    database: options.database,
    password: process.env.PGPASSWORD
  });

  try {
    // Load original checksums
    console.log(`Loading checksums from ${options.checksums}...`);
    const originalChecksums = JSON.parse(fs.readFileSync(options.checksums, 'utf8'));
    
    console.log(`Connecting to database ${options.database}...`);
    await pool.connect();

    const verificationResults = {
      timestamp: new Date().toISOString(),
      original_timestamp: originalChecksums.timestamp,
      database: options.database,
      tables: {},
      overall_status: 'PASS',
      corruption_detected: false
    };

    for (const [tableName, originalTableData] of Object.entries(originalChecksums.tables)) {
      if (originalTableData.error) {
        console.log(`Skipping table ${tableName} (error in original checksums)`);
        continue;
      }

      console.log(`Verifying table: ${tableName}`);
      
      try {
        // Get current table structure
        const columnsQuery = `
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_name = $1 
          ORDER BY ordinal_position
        `;
        const columnsResult = await pool.query(columnsQuery, [tableName]);
        
        if (columnsResult.rows.length === 0) {
          console.log(`  Table ${tableName} not found after restore - CORRUPTION DETECTED`);
          verificationResults.tables[tableName] = {
            status: 'FAIL',
            error: 'Table not found after restore'
          };
          verificationResults.corruption_detected = true;
          verificationResults.overall_status = 'FAIL';
          continue;
        }

        const columnNames = columnsResult.rows.map(row => row.column_name);
        
        // Get all rows and generate checksums
        const rowsQuery = `
          SELECT ${columnNames.map((col, i) => `"${col}"`).join(', ')}
          FROM "${tableName}"
          ORDER BY id
        `;
        
        const rowsResult = await pool.query(rowsQuery);
        
        const tableResult = {
          original_row_count: originalTableData.row_count,
          current_row_count: rowsResult.rows.length,
          row_matches: 0,
          row_mismatches: 0,
          missing_rows: 0,
          extra_rows: 0,
          status: 'PASS'
        };

        // Verify row count
        if (rowsResult.rows.length !== originalTableData.row_count) {
          console.log(`  Row count mismatch: expected ${originalTableData.row_count}, got ${rowsResult.rows.length}`);
          tableResult.status = 'FAIL';
          tableResult.row_count_mismatch = true;
          verificationResults.corruption_detected = true;
          verificationResults.overall_status = 'FAIL';
        }

        // Create a map of original checksums for easy lookup
        const originalChecksumMap = new Map();
        for (const checksumData of originalTableData.checksums) {
          originalChecksumMap.set(checksumData.row_id, checksumData.checksum);
        }

        // Verify each row
        for (const row of rowsResult.rows) {
          const rowString = columnNames.map(col => {
            const value = row[col];
            if (value === null) return 'NULL';
            if (value instanceof Date) return value.toISOString();
            return String(value);
          }).join('|');

          const currentChecksum = crypto.createHash('sha256').update(rowString).digest('hex');
          const rowId = row.id || row.public_key || row.donor_address || row.transaction_hash || 'unknown';
          
          const originalChecksum = originalChecksumMap.get(rowId);
          
          if (originalChecksum === undefined) {
            tableResult.extra_rows++;
            console.log(`  Extra row detected: ${rowId}`);
            tableResult.status = 'FAIL';
            verificationResults.corruption_detected = true;
            verificationResults.overall_status = 'FAIL';
          } else if (originalChecksum !== currentChecksum) {
            tableResult.row_mismatches++;
            console.log(`  Row checksum mismatch: ${rowId}`);
            tableResult.status = 'FAIL';
            verificationResults.corruption_detected = true;
            verificationResults.overall_status = 'FAIL';
          } else {
            tableResult.row_matches++;
          }
        }

        // Check for missing rows
        tableResult.missing_rows = originalTableData.row_count - tableResult.row_matches - tableResult.row_mismatches;
        if (tableResult.missing_rows > 0) {
          console.log(`  Missing rows detected: ${tableResult.missing_rows}`);
          tableResult.status = 'FAIL';
          verificationResults.corruption_detected = true;
          verificationResults.overall_status = 'FAIL';
        }

        // Verify table-level checksum
        const currentTableChecksums = [];
        for (const row of rowsResult.rows) {
          const rowString = columnNames.map(col => {
            const value = row[col];
            if (value === null) return 'NULL';
            if (value instanceof Date) return value.toISOString();
            return String(value);
          }).join('|');
          currentTableChecksums.push(crypto.createHash('sha256').update(rowString).digest('hex'));
        }
        
        const currentTableChecksum = crypto.createHash('sha256')
          .update(currentTableChecksums.join(''))
          .digest('hex');

        tableResult.original_table_checksum = originalTableData.table_checksum;
        tableResult.current_table_checksum = currentTableChecksum;
        
        if (originalTableData.table_checksum !== currentTableChecksum) {
          console.log(`  Table-level checksum mismatch`);
          tableResult.status = 'FAIL';
          verificationResults.corruption_detected = true;
          verificationResults.overall_status = 'FAIL';
        }

        verificationResults.tables[tableName] = tableResult;
        console.log(`  Table verification: ${tableResult.status}`);
        
      } catch (error) {
        console.error(`  Error verifying table ${tableName}: ${error.message}`);
        verificationResults.tables[tableName] = {
          status: 'ERROR',
          error: error.message
        };
        verificationResults.overall_status = 'FAIL';
      }
    }

    // Generate overall result
    console.log(`\n=== Restore Verification Results ===`);
    console.log(`Overall Status: ${verificationResults.overall_status}`);
    console.log(`Corruption Detected: ${verificationResults.corruption_detected}`);
    
    if (verificationResults.corruption_detected) {
      console.error('\n❌ SILENT DATA CORRUPTION DETECTED DURING RESTORE!');
      console.error('The backup may be corrupted or the restore process failed silently.');
      process.exit(1);
    } else {
      console.log('\n✅ Restore verification passed - no data corruption detected.');
    }

    // Output verification results
    const outputFile = options.checksums.replace('.json', '_verification.json');
    fs.writeFileSync(outputFile, JSON.stringify(verificationResults, null, 2));
    console.log(`Verification results written to ${outputFile}`);

  } catch (error) {
    console.error(`Error verifying checksums: ${error.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

verifyChecksums();