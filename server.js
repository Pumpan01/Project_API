// server.js
const express = require("express");
const path = require("path");
const multer = require("multer");
const cors = require("cors");
const bcrypt = require("bcrypt");
const { body, validationResult } = require("express-validator");
require("dotenv").config();
const pool = require("./database"); // ไฟล์เชื่อมต่อ MySQL ของคุณ

const app = express();
const port = process.env.PORT || 4000;
const host = process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : '0.0.0.0';

// กำหนด saltRounds สำหรับ bcrypt
const saltRounds = 10;

// ============================================
// 1. แก้ไข CORS (สำคัญ!)
// ============================================

// 1) เพิ่ม CORS middleware
app.use(
  cors({
    origin: "https://horplus.work", // frontend ที่อนุญาต
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true, // ถ้าต้องการส่ง cookie/token ไปด้วย
  })
);

// 2) รองรับ preflight request (OPTIONS) โดยอัตโนมัติ
app.options("*", cors());

// ============================================
// 2. ตัวอย่าง Middleware อื่น ๆ
// ============================================
app.use(express.json());

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "เกิดข้อผิดพลาดในเซิร์ฟเวอร์" });
});

// ตั้งค่า Ping MySQL ทุก 5 นาที
setInterval(async () => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    console.log("✅ MySQL Ping Success (Connection Alive)");
    connection.release();
  } catch (err) {
    console.error("❌ MySQL Ping Failed:", err);
  }
}, 5 * 60 * 1000);

// ============================================
// 3. File Upload (Multer) Setup
// ============================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(
      null,
      file.fieldname + "-" + Date.now() + path.extname(file.originalname)
    );
  },
});
const upload = multer({ storage });

// Endpoint อัปโหลดไฟล์
app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "ไม่พบไฟล์ที่ถูกอัปโหลด" });
  }
  res.status(200).json({
    message: "อัปโหลดรูปสำเร็จ",
    file: {
      originalname: req.file.originalname,
      filename: req.file.filename,
      path: req.file.path,
    },
  });
});

// Static middleware สำหรับเข้าถึงไฟล์อัปโหลด
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ============================================
// 4. Authentication APIs (Register, Login)
// ============================================

/*
  POST /api/register - สมัครสมาชิก
  1) สร้าง user ใหม่ (hash password)
  2) ตรวจสอบห้องว่ามีอยู่และว่างหรือไม่
  3) หากมีการระบุ room_number ให้อัปเดตสถานะของห้องเป็น 'occupied'
*/
app.post(
  "/api/register",
  [
    body("username").notEmpty().withMessage("กรุณากรอกชื่อผู้ใช้"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร"),
    // full_name, phone_number, line_id, role เป็น optional
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, password, full_name, phone_number, line_id, role, room_number } = req.body;

    try {
      let finalRoomNumber = room_number || null;

      // หากระบุหมายเลขห้อง ให้ตรวจสอบว่ามีอยู่และว่างหรือไม่
      if (finalRoomNumber) {
        // ตรวจสอบห้องมีอยู่ในระบบหรือไม่
        const [roomExists] = await pool.query(
          "SELECT * FROM rooms WHERE room_number = ?",
          [finalRoomNumber]
        );
        if (roomExists.length === 0) {
          return res
            .status(400)
            .json({ error: `ห้องหมายเลข ${finalRoomNumber} ไม่มีอยู่ในระบบ` });
        }
        // ตรวจสอบว่าห้องนั้นถูกใช้งานอยู่หรือไม่ โดยดูจากผู้ใช้ที่มี room_number เดียวกัน
        const [roomInUse] = await pool.query(
          "SELECT * FROM users WHERE room_number = ?",
          [finalRoomNumber]
        );
        if (roomInUse.length > 0) {
          return res
            .status(400)
            .json({ error: `ห้องหมายเลข ${finalRoomNumber} ถูกใช้งานแล้ว` });
        }
      }

      // เข้ารหัสรหัสผ่านด้วย bcrypt
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      const [userInsert] = await pool.query(
        `INSERT INTO users 
           (username, password, full_name, phone_number, line_id, role, room_number) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          username,
          hashedPassword,
          full_name || null,
          phone_number || null,
          line_id || null,
          role || "user",
          finalRoomNumber,
        ]
      );
      const userId = userInsert.insertId;

      // หากมีการระบุหมายเลขห้อง ให้ปรับปรุงสถานะห้องเป็น 'occupied'
      if (finalRoomNumber) {
        await pool.query(
          "UPDATE rooms SET status = 'occupied' WHERE room_number = ?",
          [finalRoomNumber]
        );
      }

      return res.status(201).json({ message: "สมัครสมาชิกสำเร็จ", userId });
    } catch (error) {
      console.error("Error adding new user:", error);
      if (error.code === "ER_DUP_ENTRY") {
        return res
          .status(400)
          .json({ error: `ชื่อผู้ใช้งาน '${username}' ซ้ำ กรุณาเลือกชื่ออื่น` });
      }
      return res.status(500).json({ error: "เกิดข้อผิดพลาดในการสมัครสมาชิก" });
    }
  }
);

/*
  POST /api/login-admin - เข้าสู่ระบบ (สำหรับ admin)
*/
app.post(
  "/api/login-admin",
  [
    body("username").notEmpty().withMessage("กรุณากรอกชื่อผู้ใช้"),
    body("password").notEmpty().withMessage("กรุณากรอกรหัสผ่าน"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { username, password } = req.body;
    try {
      const [rows] = await pool.query(
        "SELECT * FROM users WHERE username = ?",
        [username]
      );
      if (rows.length === 0) {
        return res
          .status(401)
          .json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
      }
      const user = rows[0];
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        return res
          .status(401)
          .json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
      }

      if (user.role !== "admin") {
        return res.status(401).json({ error: "คุณไม่มีสิทธิ์เข้าสู่ระบบ" });
      }

      res.json({
        message: "เข้าสู่ระบบสำเร็จ",
        user: {
          user_id: user.user_id,
          room_number: user.room_number,
          username: user.username,
          full_name: user.full_name,
          phone_number: user.phone_number,
          line_id: user.line_id,
          role: user.role,
          created_at: user.created_at,
        },
      });
    } catch (error) {
      console.error("Error logging in:", error);
      res.status(500).json({ error: "เกิดข้อผิดพลาดในเซิร์ฟเวอร์" });
    }
  }
);

/*
  POST /api/login - เข้าสู่ระบบ (สำหรับผู้ใช้งานทั่วไป)
*/
app.post(
  "/api/login",
  [
    body("username").notEmpty().withMessage("กรุณากรอกชื่อผู้ใช้"),
    body("password").notEmpty().withMessage("กรุณากรอกรหัสผ่าน"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { username, password } = req.body;
    try {
      const [rows] = await pool.query(
        "SELECT * FROM users WHERE username = ?",
        [username]
      );
      if (rows.length === 0) {
        return res
          .status(401)
          .json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
      }
      const user = rows[0];
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        return res
          .status(401)
          .json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
      }
      res.json({
        message: "เข้าสู่ระบบสำเร็จ",
        user: {
          user_id: user.user_id,
          room_number: user.room_number,
          username: user.username,
          full_name: user.full_name,
          phone_number: user.phone_number,
          line_id: user.line_id,
          role: user.role,
          created_at: user.created_at,
        },
      });
    } catch (error) {
      console.error("Error logging in:", error);
      res.status(500).json({ error: "เกิดข้อผิดพลาดในเซิร์ฟเวอร์" });
    }
  }
);

// ============================================
// 5. User APIs
// ============================================

/*
  GET /api/users - ดึงข้อมูลผู้ใช้ทั้งหมด (ไม่รวม password)
  + คำนวณ total_unpaid_amount (บิลที่ยังไม่ชำระ) ต่อ room_number
*/
app.get("/api/users", async (req, res) => {
  try {
    const query = `
      SELECT 
        user_id,
        username,
        full_name,
        phone_number,
        line_id,
        room_number,
        role,
        created_at,
        (SELECT IFNULL(SUM(b.total_amount), 0)
         FROM bills b
         WHERE b.room_number = users.room_number 
           AND b.payment_state = 'unpaid'
        ) AS total_unpaid_amount
      FROM users
    `;
    const [rows] = await pool.query(query);
    res.json(rows);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลผู้ใช้" });
  }
});


/*
  GET /api/users/:user_id - ดึงข้อมูลผู้ใช้ (profile)
*/
app.get("/api/users/:user_id", async (req, res) => {
  const { user_id } = req.params;
  try {
    const [rows] = await pool.query(
      "SELECT user_id, username, full_name, phone_number, line_id, room_number, role, created_at FROM users WHERE user_id = ?",
      [user_id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "ไม่พบข้อมูลผู้ใช้" });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error("Error fetching user profile:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลผู้ใช้" });
  }
});

/*
  PUT /api/users/:user_id - แก้ไขข้อมูลผู้ใช้
*/
app.put(
  "/api/users/:user_id",
  [
    body("username").notEmpty().withMessage("กรุณากรอกชื่อผู้ใช้"),
    body("room_number")
      .notEmpty()
      .withMessage("กรุณาระบุหมายเลขห้องที่พัก"),
    // full_name, phone_number, line_id, role เป็น optional
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { user_id } = req.params;
    const { username, password, full_name, phone_number, line_id, role, room_number } = req.body;

    try {
      // ตรวจสอบข้อมูลผู้ใช้เดิม
      const [currentUserRows] = await pool.query("SELECT * FROM users WHERE user_id = ?", [user_id]);
      if (currentUserRows.length === 0) {
        return res.status(404).json({ error: "ไม่พบผู้ใช้ที่ต้องการแก้ไข" });
      }
      const currentUser = currentUserRows[0];
      const oldRoom = currentUser.room_number;

      // ตรวจสอบว่าห้องใหม่มีผู้ใช้อื่นอยู่หรือไม่
      const [roomOccupied] = await pool.query(
        "SELECT * FROM users WHERE room_number = ? AND user_id != ?",
        [room_number, user_id]
      );
      if (roomOccupied.length > 0) {
        return res.status(400).json({ error: "หมายเลขห้องนี้ถูกใช้งานแล้ว" });
      }

      // หากมีการเปลี่ยนแปลงห้อง ให้ปรับสถานะห้องเก่าเป็น available
      if (oldRoom && oldRoom !== room_number) {
        await pool.query("UPDATE rooms SET status = 'available' WHERE room_number = ?", [oldRoom]);
      }
      // ตรวจสอบว่าห้องใหม่มีอยู่ในระบบหรือไม่
      const [roomExists] = await pool.query("SELECT * FROM rooms WHERE room_number = ?", [room_number]);
      if (roomExists.length === 0) {
        return res.status(400).json({ error: `ห้องหมายเลข ${room_number} ไม่มีอยู่ในระบบ` });
      } else {
        await pool.query("UPDATE rooms SET status = 'occupied' WHERE room_number = ?", [room_number]);
      }

      // สร้างคำสั่ง UPDATE สำหรับผู้ใช้
      let updateSql = `
        UPDATE users
        SET username = ?,
            full_name = ?,
            phone_number = ?,
            line_id = ?,
            role = ?,
            room_number = ?
      `;
      const params = [
        username,
        full_name || null,
        phone_number || null,
        line_id || null,
        role || "user",
        room_number,
      ];

      // หากมีการส่งรหัสผ่านมา ให้เข้ารหัสและอัปเดต
      if (password) {
        if (password.length < 6) {
          return res.status(400).json({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" });
        }
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        updateSql += ", password = ?";
        params.push(hashedPassword);
      }
      updateSql += " WHERE user_id = ?";
      params.push(user_id);

      const [result] = await pool.query(updateSql, params);
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "ไม่พบผู้ใช้ที่ต้องการแก้ไข" });
      }
      res.json({ message: "แก้ไขข้อมูลผู้ใช้เรียบร้อยแล้ว" });
    } catch (error) {
      console.error("Error updating user:", error);
      if (error.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ error: `ชื่อผู้ใช้งาน '${username}' ซ้ำ กรุณาเลือกชื่ออื่น` });
      }
      res.status(500).json({ error: "เกิดข้อผิดพลาดในการแก้ไขข้อมูลผู้ใช้" });
    }
  }
);

/*
  DELETE /api/users/:user_id - ลบผู้ใช้ (และอัปเดตสถานะห้องให้เป็น available)
*/
app.delete("/api/users/:user_id", async (req, res) => {
  const { user_id } = req.params;
  try {
    const [userRows] = await pool.query("SELECT * FROM users WHERE user_id = ?", [user_id]);
    if (userRows.length === 0) {
      return res.status(404).json({ error: "ไม่พบผู้ใช้ที่ต้องการลบ" });
    }
    const room_number = userRows[0].room_number;
    const [result] = await pool.query("DELETE FROM users WHERE user_id = ?", [user_id]);
    if (result.affectedRows > 0 && room_number) {
      // เปลี่ยนสถานะห้องกลับเป็น available หากผู้ใช้ที่มีห้องถูกลบออก
      await pool.query("UPDATE rooms SET status = 'available' WHERE room_number = ?", [room_number]);
    }
    res.json({ message: "ลบผู้ใช้เรียบร้อยแล้ว" });
  } catch (error) {
    console.error("Error deleting user:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการลบผู้ใช้" });
  }
});

// ============================================
// 6. Bill & Payment APIs
// ============================================

/*
  GET /api/bills - ดึงข้อมูลบิล (ทั้งหมดหรือเฉพาะของผู้ใช้)
*/
app.get("/api/bills", async (req, res) => {
  const { user_id, is_admin } = req.query;
  try {
    let query;
    let params = [];
    if (is_admin === "true") {
      query = `
        SELECT b.bill_id, b.user_id, b.room_number, 
               b.water_units, b.electricity_units, 
               b.total_amount, b.due_date, b.slip_path, b.payment_state, b.paid_date
        FROM bills b
      `;
    } else {
      if (!user_id) {
        return res.status(400).json({ error: "กรุณาระบุ user_id" });
      }
      query = `
        SELECT b.bill_id, b.room_number, 
               b.water_units, b.electricity_units, 
               b.total_amount, b.due_date, b.slip_path, b.payment_state, b.paid_date
        FROM bills b
        WHERE b.user_id = ?
      `;
      params.push(user_id);
    }
    const [rows] = await pool.query(query, params);
    if (rows.length === 0) {
      return res.status(404).json({ error: "ไม่พบบิล" });
    }
    res.json(rows);
  } catch (error) {
    console.error("❌ Error fetching bills:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลบิล" });
  }
});

/*
  GET /api/bills/:id - ดึงข้อมูลบิลตาม bill_id
*/
app.get("/api/bills/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query("SELECT * FROM bills WHERE bill_id = ?", [
      id,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "ไม่พบบิลนี้" });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error("❌ Error fetching bill:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลบิล" });
  }
});

/*
  POST /api/bills - เพิ่มบิลใหม่
*/
app.post("/api/bills", async (req, res) => {
  const {
    user_id,
    room_number,
    meter,
    water_units,
    electricity_units,
    due_date,
  } = req.body;

  // ตัวอย่าง rate น้ำ/ไฟ (Hard-coded)
  const water_rate = 20;
  const electricity_rate = 8;

  try {
    // 1) ค้นหา rent จาก rooms
    const [roomRows] = await pool.query(
      "SELECT rent FROM rooms WHERE room_number = ?",
      [room_number]
    );
    if (roomRows.length === 0) {
      return res.status(400).json({ msg: `ไม่พบห้องหมายเลข ${room_number}` });
    }
    // ดึง rent
    const rentAmount = roomRows[0].rent;

    // 2) บันทึกบิล ลงในตาราง bills
    const sql = `
        INSERT INTO bills (
          user_id, 
          room_number, 
          water_units, 
          electricity_units, 
          water_rate, 
          electricity_rate,
          rent_amount,
          due_date, 
          meter
        ) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

    const [result] = await pool.query(sql, [
      user_id,
      room_number,
      water_units,
      electricity_units,
      water_rate,
      electricity_rate,
      rentAmount,
      due_date,
      meter,
    ]);

    return res.status(201).json({
      message: "เพิ่มบิลสำเร็จ",
      bill_id: result.insertId,
    });
  } catch (error) {
    console.error("❌ Error adding bill:", error);
    return res.status(500).json({ error: "เกิดข้อผิดพลาดในการเพิ่มบิล" });
  }
});

/*
  PUT /api/bills/:id - อัปเดตสถานะบิลและบันทึกประวัติการชำระเงิน (payment_history)
*/
app.put("/api/bills/:id", async (req, res) => {
  const { id } = req.params;
  const {
    slip_path,
    meter, // รับค่า meter จาก request ด้วย
    payment_state,
    paid_date,
    water_units,
    electricity_units,
    due_date,
  } = req.body;

  try {
    // 1) ดึงข้อมูลบิลเดิม
    const [oldRows] = await pool.query(
      "SELECT * FROM bills WHERE bill_id = ?",
      [id]
    );
    if (oldRows.length === 0) {
      return res.status(404).json({ error: "ไม่พบบิลที่ต้องการอัปเดต" });
    }
    const oldBill = oldRows[0];

    // 2) สร้างตัวแปรที่รวมค่าของเก่า + ของใหม่
    const newSlipPath = slip_path !== undefined ? slip_path : oldBill.slip_path;
    const newMeter = meter !== undefined ? meter : oldBill.meter; // เพิ่มฟิลด์ meter
    const newPaymentState =
      payment_state !== undefined ? payment_state : oldBill.payment_state;
    const newPaidDate = paid_date !== undefined ? paid_date : oldBill.paid_date;
    const newWaterUnits =
      water_units !== undefined ? water_units : oldBill.water_units;
    const newElectricityUnits =
      electricity_units !== undefined
        ? electricity_units
        : oldBill.electricity_units;
    const newDueDate = due_date !== undefined ? due_date : oldBill.due_date;

    // 3) อัปเดตข้อมูลบิลด้วยค่าใหม่ (รวม meter ด้วย)
    const updateSql = `
        UPDATE bills
        SET slip_path = ?,
            meter = ?,
            payment_state = ?,
            paid_date = ?,
            water_units = ?,
            electricity_units = ?,
            due_date = ?
        WHERE bill_id = ?
      `;
    const [updateResult] = await pool.query(updateSql, [
      newSlipPath,
      newMeter,
      newPaymentState,
      newPaidDate,
      newWaterUnits,
      newElectricityUnits,
      newDueDate,
      id,
    ]);

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: "ไม่พบบิลที่ต้องการอัปเดต" });
    }

    // ถ้า payment_state เปลี่ยนเป็น 'paid' ให้บันทึกลงใน payment_history
    if (newPaymentState === "paid") {
      const [billRows] = await pool.query(
        "SELECT total_amount FROM bills WHERE bill_id = ?",
        [id]
      );
      if (billRows.length === 0) {
        return res.status(404).json({ error: "ไม่พบบิลสำหรับบันทึกประวัติ" });
      }
      const amountPaid = billRows[0].total_amount;
      const paymentDate = newPaidDate || new Date().toISOString().split("T")[0];

      const insertHistorySql = `
          INSERT INTO payment_history (bill_id, amount_paid, payment_date, slip_path, created_at)
          VALUES (?, ?, ?, ?, NOW())
        `;
      await pool.query(insertHistorySql, [
        id,
        amountPaid,
        paymentDate,
        newSlipPath,
      ]);
    }

    return res.json({ message: "อัปเดตบิลเรียบร้อย (Partial Update)" });
  } catch (error) {
    console.error("❌ Error updating bill:", error);
    return res.status(500).json({ error: "เกิดข้อผิดพลาดในการอัปเดตบิล" });
  }
});


/*
  DELETE /api/bills/:id - ลบบิล
*/
app.delete("/api/bills/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const billId = parseInt(id, 10);
    if (isNaN(billId)) {
      return res.status(400).json({ error: "รหัสบิลไม่ถูกต้อง" });
    }
    const sql = "DELETE FROM bills WHERE bill_id = ?";
    const [result] = await pool.query(sql, [billId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "ไม่พบบิลที่ต้องการลบ" });
    }
    res.status(200).json({ message: "ลบบิลสำเร็จ" });
  } catch (error) {
    console.error("❌ Error deleting bill:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการลบบิล" });
  }
});

/*
  GET /api/bills/room-admin/:roomId - (admin) ดึงบิลทั้งหมดของห้องนั้น
*/
app.get("/api/bills/room-admin/:roomId", async (req, res) => {
  const { roomId } = req.params;
  try {
    const parsedRoomId = parseInt(roomId, 10);
    if (isNaN(parsedRoomId)) {
      return res.status(400).json({ error: "รหัสห้อง (roomId) ไม่ถูกต้อง" });
    }
    const sql = `
      SELECT 
        b.bill_id, b.water_units, b.electricity_units,
        b.water_rate, b.electricity_rate, b.total_amount,
        b.due_date, b.slip_path, b.meter,
        b.created_at, b.payment_state, b.paid_date,
        u.room_number, u.username, u.full_name
      FROM bills b
      LEFT JOIN users u ON b.user_id = u.user_id
      WHERE b.room_number = ?
      ORDER BY b.created_at DESC
    `;
    const [rows] = await pool.query(sql, [parsedRoomId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "ไม่พบบิลสำหรับห้องนี้" });
    }
    res.status(200).json(rows);
  } catch (error) {
    console.error("❌ Error fetching bills (admin):", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลบิล" });
  }
});

/*
  GET /api/bills/room/:roomId - ดึงบิลที่ยังไม่ชำระของห้องนั้น
*/
app.get("/api/bills/room/:roomId", async (req, res) => {
  const { roomId } = req.params;
  try {
    const parsedRoomId = parseInt(roomId, 10);
    if (isNaN(parsedRoomId)) {
      return res.status(400).json({ error: "รหัสห้อง (roomId) ไม่ถูกต้อง" });
    }
    const sql = `
      SELECT 
        b.bill_id, b.water_units, b.electricity_units,
        b.water_rate, b.electricity_rate, b.total_amount,
        b.due_date, b.slip_path, b.meter,
        b.created_at, b.payment_state, b.paid_date,
        u.room_number, u.username, u.full_name
      FROM bills b
      LEFT JOIN users u ON b.user_id = u.user_id
      WHERE b.room_number = ? AND b.payment_state != 'paid'
      ORDER BY b.created_at DESC
    `;
    const [rows] = await pool.query(sql, [parsedRoomId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "ไม่พบบิลสำหรับห้องนี้" });
    }
    res.status(200).json(rows);
  } catch (error) {
    console.error("❌ Error fetching bills for room:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลบิล" });
  }
});

/*
  GET /api/payment_history/:userId - ดึงประวัติการชำระเงินของ user
*/
app.get("/api/payment_history/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const sql = `
      SELECT 
        ph.payment_id,
        ph.bill_id,
        ph.amount_paid,
        ph.payment_date,
        ph.slip_path,
        ph.created_at,
        b.total_amount,
        b.due_date,
        b.room_number
      FROM payment_history ph
      LEFT JOIN bills b ON ph.bill_id = b.bill_id
      WHERE b.user_id = ?
      ORDER BY ph.created_at DESC
    `;
    const [rows] = await pool.query(sql, [userId]);
    if (rows.length === 0) {
      return res
        .status(404)
        .json({ error: "ไม่พบประวัติการชำระเงินสำหรับผู้ใช้นี้" });
    }
    res.json(rows);
  } catch (error) {
    console.error("Error fetching payment history:", error);
    res
      .status(500)
      .json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลประวัติการชำระเงิน" });
  }
});

// ============================================
// 7. Repairs APIs
// ============================================

/*
  GET /api/repairs - ดึงข้อมูลการแจ้งซ่อม (admin => ทั้งหมด, user => เฉพาะของตน)
*/
app.get("/api/repairs", async (req, res) => {
  try {
    const query = `
        SELECT 
          repair_id, 
          user_id, 
          room_number, 
          description, 
          status, 
          created_at,
          repair_date
        FROM repairs
      `;
    const [rows] = await pool.query(query);
    if (rows.length === 0) {
      return res.json([]);
    }
    const statusTranslations = {
      pending: "รอรับเรื่อง",
      "in progress": "กำลังดำเนินการ",
      complete: "เสร็จสิ้น",
    };
    const translatedRows = rows.map((row) => ({
      ...row,
      status: statusTranslations[row.status] || row.status,
    }));
    res.json(translatedRows);
  } catch (error) {
    console.error("Error fetching repairs:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูล" });
  }
});

app.get("/api/repairs/:user_id", async (req, res) => {
  const { user_id } = req.params;
  try {
    const query = `
        SELECT 
          repair_id,
          user_id,
          room_number,
          description,
          status,
          created_at,
          repair_date
        FROM repairs
        WHERE user_id = ?
      `;
    const [rows] = await pool.query(query, [user_id]);
    if (rows.length === 0) {
      return res.json([]);
    }
    const statusTranslations = {
      pending: "รอรับเรื่อง",
      "in progress": "กำลังดำเนินการ",
      complete: "เสร็จสิ้น",
    };
    const translatedRows = rows.map((row) => ({
      ...row,
      status: statusTranslations[row.status] || row.status,
    }));
    res.json(translatedRows);
  } catch (error) {
    console.error("Error fetching repairs:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูล" });
  }
});

/*
  POST /api/repairs - เพิ่มการแจ้งซ่อม
*/
app.post("/api/repairs", async (req, res) => {
  const { user_id, room_number, description, status, repair_date } = req.body;
  if (!user_id || !room_number || !description) {
    return res.status(400).json({
      error: "กรุณากรอกข้อมูลที่จำเป็น (user_id, room_number, description)",
    });
  }

  let repairStatus = "pending";
  if (status === "รอดำเนินการ") {
    repairStatus = "pending";
  } else if (status === "กำลังดำเนินการ") {
    repairStatus = "in progress";
  } else if (status === "เสร็จสิ้น") {
    repairStatus = "complete";
  }

  try {
    const [userCheck] = await pool.query(
      "SELECT * FROM users WHERE user_id = ?",
      [user_id]
    );
    if (userCheck.length === 0) {
      return res.status(404).json({ error: "ไม่พบผู้ใช้งานที่ระบุ" });
    }
    const [roomCheck] = await pool.query(
      "SELECT * FROM rooms WHERE room_number = ?",
      [room_number]
    );
    if (roomCheck.length === 0) {
      return res.status(404).json({ error: "ไม่พบห้องที่ระบุ" });
    }

    const sql = `
        INSERT INTO repairs (user_id, room_number, description, status, repair_date)
        VALUES (?, ?, ?, ?, ?)
      `;
    const [result] = await pool.query(sql, [
      user_id,
      room_number,
      description,
      repairStatus,
      repair_date || new Date().toISOString().slice(0, 10),
    ]);
    res.status(201).json({
      message: "เพิ่มข้อมูลการแจ้งซ่อมสำเร็จ",
      repair_id: result.insertId,
    });
  } catch (error) {
    console.error("Error adding repair:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในเซิร์ฟเวอร์" });
  }
});

/*
  PUT /api/repairs/:repair_id - อัปเดตสถานะการแจ้งซ่อม
*/
app.put("/api/repairs/:repair_id", async (req, res) => {
  const { repair_id } = req.params;
  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ error: "กรุณาระบุสถานะ" });
  }
  try {
    const query = `UPDATE repairs SET status = ? WHERE repair_id = ?`;
    const [result] = await pool.query(query, [status, repair_id]);
    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ error: "ไม่พบการแจ้งซ่อมที่ต้องการอัปเดต" });
    }
    res.json({ message: "อัปเดตสถานะการแจ้งซ่อมสำเร็จ" });
  } catch (error) {
    console.error("Error updating repair status:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในเซิร์ฟเวอร์" });
  }
});

/*
  DELETE /api/repairs/:repair_id - ลบข้อมูลการแจ้งซ่อม
*/
app.delete("/api/repairs/:repair_id", async (req, res) => {
  const { repair_id } = req.params;
  try {
    const query = "DELETE FROM repairs WHERE repair_id = ?";
    const [result] = await pool.query(query, [repair_id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "ไม่พบการแจ้งซ่อมที่ต้องการลบ" });
    }
    res.json({ message: "ลบข้อมูลการแจ้งซ่อมสำเร็จ" });
  } catch (error) {
    console.error("Error deleting repair:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในเซิร์ฟเวอร์" });
  }
});

// ============================================
// 8. Announcement APIs
// ============================================

/*
  GET /api/announcements - ดึงประกาศทั้งหมด
*/
app.get("/api/announcements", async (req, res) => {
  try {
    const query = `
      SELECT announcement_id, title, detail, 
             DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM announcements
      ORDER BY created_at DESC
    `;
    const [rows] = await pool.query(query);
    res.json(rows);
  } catch (error) {
    console.error("Error fetching announcements:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูล" });
  }
});

/*
  POST /api/announcements - เพิ่มประกาศ
*/
app.post("/api/announcements", async (req, res) => {
  const { title, detail } = req.body;
  if (!title || !detail) {
    return res.status(400).json({ error: "กรุณากรอกข้อมูลที่จำเป็น" });
  }
  try {
    const query = `INSERT INTO announcements (title, detail) VALUES (?, ?)`;
    const [result] = await pool.query(query, [title, detail]);
    res.status(201).json({
      message: "เพิ่มประกาศสำเร็จ",
      announcement_id: result.insertId,
    });
  } catch (error) {
    console.error("Error adding announcement:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการเพิ่มข้อมูล" });
  }
});

/*
  PUT /api/announcements/:id - แก้ไขประกาศ
*/
app.put("/api/announcements/:id", async (req, res) => {
  const { id } = req.params;
  const { title, detail } = req.body;
  if (!title || !detail) {
    return res.status(400).json({ error: "กรุณากรอกข้อมูลที่จำเป็น" });
  }
  try {
    const query = `
      UPDATE announcements
      SET title = ?, detail = ?
      WHERE announcement_id = ?
    `;
    const [result] = await pool.query(query, [title, detail, id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "ไม่พบประกาศที่ต้องการแก้ไข" });
    }
    res.json({ message: "แก้ไขประกาศสำเร็จ" });
  } catch (error) {
    console.error("Error updating announcement:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการแก้ไขข้อมูล" });
  }
});

/*
  DELETE /api/announcements/:id - ลบประกาศ
*/
app.delete("/api/announcements/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const query = "DELETE FROM announcements WHERE announcement_id = ?";
    const [result] = await pool.query(query, [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "ไม่พบประกาศที่ต้องการลบ" });
    }
    res.json({ message: "ลบประกาศสำเร็จ" });
  } catch (error) {
    console.error("Error deleting announcement:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการลบข้อมูล" });
  }
});

// 🚀 **GET: ดึงห้องทั้งหมด**
app.get("/api/rooms", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM rooms ORDER BY room_number ASC"
    );
    res.json(rows);
  } catch (error) {
    console.error("❌ Error fetching rooms:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลห้อง" });
  }
});

// 🚀 **GET: ดึงห้องตาม room_id**
app.get("/api/rooms/:room_id", async (req, res) => {
  const { room_id } = req.params;
  try {
    const [rows] = await pool.query("SELECT * FROM rooms WHERE room_id = ?", [
      room_id,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "ไม่พบห้องนี้" });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error("❌ Error fetching room by ID:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลห้อง" });
  }
});

// 🚀 **GET: ดึงห้องทั้งหมด (รองรับการกรองตาม status)**
app.get("/api/rooms-by-status", async (req, res) => {
  const { status } = req.query;
  try {
    let sql = "SELECT * FROM rooms";
    const params = [];

    if (status) {
      sql += " WHERE status = ?";
      params.push(status);
    }
    sql += " ORDER BY room_number ASC";

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error("❌ Error fetching rooms:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลห้อง" });
  }
});

// 🚀 **POST: เพิ่มห้องใหม่**
app.post("/api/rooms", async (req, res) => {
  const { room_number, rent, description, status } = req.body;

  if (!room_number || !rent) {
    return res.status(400).json({ error: "กรุณาระบุหมายเลขห้องและค่าเช่า" });
  }

  const maxRent = 99999999;
  const parsedRent = parseFloat(rent);

  if (parsedRent < 0 || parsedRent > maxRent) {
    return res
      .status(400)
      .json({ error: `ค่าเช่าห้องต้องเป็นบวกและไม่เกิน ${maxRent}` });
  }

  try {
    const [existingRoom] = await pool.query(
      "SELECT * FROM rooms WHERE room_number = ?",
      [room_number]
    );
    if (existingRoom.length > 0) {
      return res
        .status(400)
        .json({ error: `ห้องหมายเลข ${room_number} มีอยู่แล้ว` });
    }

    const [result] = await pool.query(
      "INSERT INTO rooms (room_number, rent, description, status) VALUES (?, ?, ?, ?)",
      [room_number, parsedRent, description || "", status || "available"]
    );

    res
      .status(201)
      .json({ message: "เพิ่มห้องสำเร็จ", room_id: result.insertId });
  } catch (error) {
    console.error("❌ Error adding room:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการเพิ่มห้อง" });
  }
});

// 🚀 **PUT: อัปเดตข้อมูลห้อง**
app.put("/api/rooms/:room_id", async (req, res) => {
  const { room_id } = req.params;
  const { room_number, rent, description, status } = req.body;

  if (!room_number || !rent) {
    return res.status(400).json({ error: "กรุณาระบุหมายเลขห้องและค่าเช่า" });
  }

  const maxRent = 99999999;
  const parsedRent = parseFloat(rent);
  if (parsedRent < 0 || parsedRent > maxRent) {
    return res
      .status(400)
      .json({ error: `ค่าเช่าห้องต้องเป็นบวกและไม่เกิน ${maxRent}` });
  }

  try {
    const [roomExists] = await pool.query(
      "SELECT * FROM rooms WHERE room_id = ?",
      [room_id]
    );
    if (roomExists.length === 0) {
      return res.status(404).json({ error: "ไม่พบห้องที่ต้องการแก้ไข" });
    }

    const [duplicateCheck] = await pool.query(
      "SELECT * FROM rooms WHERE room_number = ? AND room_id != ?",
      [room_number, room_id]
    );
    if (duplicateCheck.length > 0) {
      return res
        .status(400)
        .json({ error: `ห้องหมายเลข ${room_number} มีอยู่แล้ว` });
    }

    await pool.query(
      "UPDATE rooms SET room_number = ?, rent = ?, description = ?, status = ? WHERE room_id = ?",
      [
        room_number,
        parsedRent,
        description || "",
        status || "available",
        room_id,
      ]
    );

    res.json({ message: "แก้ไขข้อมูลห้องสำเร็จ" });
  } catch (error) {
    console.error("❌ Error updating room:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการแก้ไขห้อง" });
  }
});

// 🚀 **DELETE: ลบห้อง**
app.delete("/api/rooms/:room_id", async (req, res) => {
  const { room_id } = req.params;
  try {
    const [result] = await pool.query("DELETE FROM rooms WHERE room_id = ?", [
      room_id,
    ]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "ไม่พบห้องที่ต้องการลบ" });
    }
    res.json({ message: "ลบห้องสำเร็จ" });
  } catch (error) {
    console.error("❌ Error deleting room:", error);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการลบห้อง" });
  }
});

// ============================================
// 9. Start Server
// ============================================
app.listen(port, host, () => {
  console.log(`เซิร์ฟเวอร์กำลังทำงานที่ ${host}:${port} (IPv4)`);
});