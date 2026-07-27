import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

const app = express();

app.use(express.json({ limit: "10mb" }));

/*
  These are the four GitHub Pages origins permitted
  to communicate with this backend.
*/
const defaultAllowedOrigins = [
  "https://experiment2026.github.io"
];

/*
  You can optionally define ALLOWED_ORIGINS in Render
  as a comma-separated list.

  Note: All four GitHub Pages repositories use the same
  browser origin: https://experiment2026.github.io

  The repository path is not part of the origin.
*/
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : defaultAllowedOrigins;

app.use(
  cors({
    origin(origin, callback) {
      /*
        Requests without an Origin header include direct browser
        visits, health checks, and server-to-server requests.
      */
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn(`Blocked CORS origin: ${origin}`);

      return callback(
        new Error("This origin is not permitted by CORS.")
      );
    }
  })
);

/*
  Connect to Render PostgreSQL.

  Use the Internal Database URL as DATABASE_URL when the
  backend and database are both hosted on Render.
*/
if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is missing. Add it to the Render environment variables."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DB_SSL === "true"
      ? {
          rejectUnauthorized: false
        }
      : false
});

/*
  Valid experimental conditions.

  The backend rejects unknown condition labels so that
  spelling mistakes do not create incorrect study groups.
*/
const validConditions = new Set([
  "interface_text_input_text",
  "interface_text_input_speech",
  "interface_video_input_text",
  "interface_video_input_speech"
]);

/*
  Create the PostgreSQL table automatically.

  Each participant-condition-version combination has one row.
  Every autosave replaces the stored transcript with the latest
  complete version sent by the frontend.
*/
async function initialiseDatabase() {
  const query = `
    CREATE TABLE IF NOT EXISTS transcripts (
      id BIGSERIAL PRIMARY KEY,

      participant_id VARCHAR(100) NOT NULL,
      condition VARCHAR(100) NOT NULL,
      study_version VARCHAR(50) NOT NULL DEFAULT 'v1',

      transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
      message_count INTEGER NOT NULL DEFAULT 0,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT unique_transcript_record
        UNIQUE (
          participant_id,
          condition,
          study_version
        )
    );
  `;

  await pool.query(query);

  console.log("PostgreSQL transcripts table is ready.");
}

/*
  Basic status route
*/
app.get("/", (req, res) => {
  res.send("Anam experiment backend is running.");
});

/*
  Database health check
*/
app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT NOW() AS database_time;"
    );

    res.json({
      success: true,
      databaseConnected: true,
      databaseTime: result.rows[0].database_time
    });
  } catch (error) {
    console.error("Database health-check error:", error);

    res.status(500).json({
      success: false,
      databaseConnected: false,
      error: "Database connection failed."
    });
  }
});

/*
  Create an Anam session token
*/
app.post("/api/session-token", async (req, res) => {
  try {
    const response = await fetch(
      "https://api.anam.ai/v1/auth/session-token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.ANAM_API_KEY}`
        },
        body: JSON.stringify({
          personaConfig: {
            name:
              process.env.PERSONA_NAME ||
              "Study Agent",

            avatarId:
              process.env.ANAM_AVATAR_ID,

            voiceId:
              process.env.ANAM_VOICE_ID,

            llmId:
              process.env.ANAM_LLM_ID,

            systemPrompt:
              process.env.ANAM_SYSTEM_PROMPT ||
              "Respond helpfully."
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "Anam session-token error:",
        response.status,
        data
      );

      return res.status(response.status).json(data);
    }

    res.json({
      sessionToken: data.sessionToken
    });
  } catch (error) {
    console.error("Session token error:", error);

    res.status(500).json({
      error: "Failed to create session token."
    });
  }
});

/*
  Save or update a complete transcript.

  Expected frontend request:

  {
    participantId: "P014",
    condition: "interface_video_input_speech",
    studyVersion: "v1",
    transcript: [...]
  }
*/
app.post("/api/save-transcript", async (req, res) => {
  try {
    const {
      participantId,
      condition,
      studyVersion =
        process.env.STUDY_VERSION || "v1",
      transcript = []
    } = req.body;

    if (!participantId) {
      return res.status(400).json({
        error: "participantId is required."
      });
    }

    if (!condition) {
      return res.status(400).json({
        error: "condition is required."
      });
    }

    if (!Array.isArray(transcript)) {
      return res.status(400).json({
        error: "transcript must be an array."
      });
    }

    const safeParticipantId = String(participantId)
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "");

    const safeCondition = String(condition)
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "");

    const safeStudyVersion = String(studyVersion)
      .trim()
      .replace(/[^a-zA-Z0-9_.-]/g, "");

    if (!safeParticipantId) {
      return res.status(400).json({
        error: "participantId is invalid."
      });
    }

    if (!validConditions.has(safeCondition)) {
      return res.status(400).json({
        error: "Unknown experimental condition.",
        receivedCondition: safeCondition,
        validConditions: Array.from(validConditions)
      });
    }

    if (!safeStudyVersion) {
      return res.status(400).json({
        error: "studyVersion is invalid."
      });
    }

    const saveQuery = `
      INSERT INTO transcripts (
        participant_id,
        condition,
        study_version,
        transcript,
        message_count,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4::jsonb,
        $5,
        NOW(),
        NOW()
      )

      ON CONFLICT (
        participant_id,
        condition,
        study_version
      )

      DO UPDATE SET
        transcript = EXCLUDED.transcript,
        message_count = EXCLUDED.message_count,
        updated_at = NOW()

      RETURNING
        id,
        participant_id,
        condition,
        study_version,
        message_count,
        created_at,
        updated_at;
    `;

    const values = [
      safeParticipantId,
      safeCondition,
      safeStudyVersion,
      JSON.stringify(transcript),
      transcript.length
    ];

    const result = await pool.query(
      saveQuery,
      values
    );

    res.json({
      success: true,
      savedTranscript: result.rows[0]
    });
  } catch (error) {
    console.error("Save transcript error:", error);

    res.status(500).json({
      error: "Failed to save transcript."
    });
  }
});

/*
  List transcript summaries.

  This does not return the complete conversation text.
*/
app.get("/api/transcripts", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        participant_id,
        condition,
        study_version,
        message_count,
        created_at,
        updated_at
      FROM transcripts
      ORDER BY updated_at DESC;
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("List transcripts error:", error);

    res.status(500).json({
      error: "Failed to list transcripts."
    });
  }
});

/*
  Retrieve one complete transcript.

  Example:
  /api/transcripts/P014/interface_video_input_speech
*/
app.get(
  "/api/transcripts/:participantId/:condition",
  async (req, res) => {
    try {
      const participantId = String(
        req.params.participantId
      )
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, "");

      const condition = String(
        req.params.condition
      )
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, "");

      const studyVersion = String(
        req.query.studyVersion ||
          process.env.STUDY_VERSION ||
          "v1"
      )
        .trim()
        .replace(/[^a-zA-Z0-9_.-]/g, "");

      const result = await pool.query(
        `
          SELECT
            id,
            participant_id,
            condition,
            study_version,
            transcript,
            message_count,
            created_at,
            updated_at
          FROM transcripts
          WHERE participant_id = $1
            AND condition = $2
            AND study_version = $3;
        `,
        [
          participantId,
          condition,
          studyVersion
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Transcript not found."
        });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error("Read transcript error:", error);

      res.status(500).json({
        error: "Failed to retrieve transcript."
      });
    }
  }
);

/*
  Export all transcripts as one JSON file.
*/
app.get(
  "/api/export-transcripts",
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          participant_id,
          condition,
          study_version,
          transcript,
          message_count,
          created_at,
          updated_at
        FROM transcripts
        ORDER BY
          study_version,
          condition,
          participant_id;
      `);

      const date = new Date()
        .toISOString()
        .slice(0, 10);

      const filename =
        `anam-transcripts-${date}.json`;

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      res.setHeader(
        "Content-Type",
        "application/json"
      );

      res.send(
        JSON.stringify(result.rows, null, 2)
      );
    } catch (error) {
      console.error(
        "Export transcripts error:",
        error
      );

      res.status(500).json({
        error: "Failed to export transcripts."
      });
    }
  }
);

const port = process.env.PORT || 10000;

async function startServer() {
  try {
    await initialiseDatabase();

    app.listen(port, "0.0.0.0", () => {
      console.log(
        `Server listening on port ${port}`
      );
    });
  } catch (error) {
    console.error(
      "The server could not start because PostgreSQL could not be initialised:",
      error
    );

    process.exit(1);
  }
}

startServer();

async function shutdown() {
  console.log(
    "Closing PostgreSQL connection..."
  );

  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
