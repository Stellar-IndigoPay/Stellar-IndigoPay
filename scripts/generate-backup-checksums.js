#!/usr/bin/env node

/**
 * Generate row-level checksums for key database tables.
 * This script creates SHA-256 checksums for each row in critical tables
 * to detect silent data corruption during restore operations.
 * 
 * Usage: node scripts/generate-backup-checksums.js --host <host> --port <port> --user <user> --database <db> --output <output.json>
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

const required = ['host', 'port', 'user', 'database', 'output'];
for (const req of required) {
  if (!options[req]) {
    console.error(`Missing required argument: --${req}`);
    process.exit(1);
  }
}

// Key tables to checksum (critical business data)
const KEY_TABLES = [
  'projects',
  'donations', 
  'profiles',
  'verification_requests',
  'donation_events',
  'projection_donor_leaderboard',
  'projection_project_stats'
];

async function generateChecksums() {
  const pool = new Pool({
    host: options.host,
    port: parseInt(options.port),
    user: options.user,
    database: options.database,
    password: process.env.PGPASSWORD
  });

  try {
    const checksums = {
      timestamp: new Date().toISOString(),
      database: options.database,
      tables: {}
    };

    console.log(`Connecting to database ${options.database}...`);
    await pool.connect();

    for (const table of KEY_TABLES) {
      console.log(`Generating checksums for table: ${table}`);
      
      try {
        // Get table structure
        const columnsQuery = `
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_name = $1 
          ORDER BY ordinal_position
        `;
        const columnsResult = await pool.query(columnsQuery, [table]);
        
        if (columnsResult.rows.length === 0) {
          console.log(`  Table ${table} not found or has no columns, skipping`);
          continue;
        }

        const columnNames = columnsResult.rows.map(row => row.column_name);
        
        // Get all rows and generate checksums
        const rowsQuery = `
          SELECT ${columnNames.map((col, i) => `"${col}"`).join(', ')}
          FROM "${table}"
          ORDER BY id
        `;
        
        const rowsResult = await pool.query(rowsQuery);
        
        const tableChecksums = {
          row_count: rowsResult.rows.length,
          column_names: columnNames,
          checksums: []
        };

        for (const row of rowsResult.rows) {
          // Create a deterministic string representation of the row
          const rowString = columnNames.map(col => {
            const value = row[col];
            if (value === null) return 'NULL';
            if (value instanceof Date) return value.toISOString();
            return String(value);
          }).join('|');

          // Generate SHA-256 checksum
          const checksum = crypto.createHash('sha256').update(rowString).digest('hex');
          
          tableChecksums.checksums.push({
            row_id: row.id || row.public_key || row.donor_address || row.transaction_hash || 'unknown',
            checksum: checksum
          });
        }

        // Generate table-level checksum (checksum of all row checksums)
        const allChecksums = tableChecksums.checksums.map(c => c.checksum).join('');
        tableChecksums.table_checksum = crypto.createHash('sha256').update(allChecksums).digest('hex');

        checksums.tables[table] = tableChecksums;
        console.log(`  Generated ${tableChecksums.row_count} row checksums for ${table}`);
        
      } catch (error) {
        console.error(`  Error processing table ${table}: ${error.message}`);
        checksums.tables[table] = {
          error: error.message,
          row_count: 0,
          checksums: []
        };
      }
    }

    // Generate overall database checksum
    const tableChecksums = Object.values(checksums.tables)
      .filter(t => t.table_checksum)
      .map(t => t.table_checksum)
      .join('');
    
    checksums.database_checksum = crypto.createHash('sha256').update(tableChecksums).digest('hex');

    // Write checksums to file
    fs.writeFileSync(options.output, JSON.stringify(checksums, null, 2));
    console.log(`Checksums written to ${options.output}`);
    console.log(`Database checksum: ${checksums.database_checksum}`);

  } catch (error) {
    console.error(`Error generating checksums: ${error.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

generateChecksums();