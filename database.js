const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "your_database_name",
  waitForConnections: true,
  connectionLimit: 10, // จำกัดการเชื่อมต่อ
  queueLimit: 0,
});

pool
  .getConnection()
  .then((conn) => {
    console.log("✅ MySQL Database Connected!");
    conn.release();
  })
  .catch((err) => {
    console.error("❌ Database Connection Failed:", err);
  });

module.exports = pool;
