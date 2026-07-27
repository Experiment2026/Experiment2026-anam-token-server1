import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

const app = express();

app.use(
  express.json({
    limit: "10mb"
  })
);

/*
  All four GitHub Pages repositories are hosted under
  this same browser origin.
*/
const defaultAllowedOrigins = [
  "https://experiment2026.github.io"
];

const allowedOrigins =
  process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    : defaultAllowedOrigins;

app.use(
  cors({
    origin(origin, callback) {
      /*
        Allow direct browser requests and health checks that
        do not include an Origin header.
      */
      if (!origin) {
        return callback(null, true);
      }

      if (
        allowedOrigins.includes(origin)
      ) {
        return callback(null, true);
      }

      console.warn(
        `Blocked CORS origin: ${origin}`
      );

      return callback(
        new Error(
          "This origin is not permitted by CORS."
        )
      );
    }
  })
);

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is missing. Add it to the Render environment variables."
  );
}

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL,

  /*
    The Internal Database URL normally uses Render's
    private network without this SSL override.

    DB_SSL can be set to true if the database connection
    being used requires SSL.
  */
  ssl:
    process.env.DB_SSL === "true"
      ? {
          rejectUnauthorized: false
        }
      : false
});

/*
  Only these four condition labels are accepted.
*/
const validConditions = new Set([
  "interface_text_input_text",
  "interface_text_input_speech",
  "interface_video_input_text",
  "interface_video_input_speech"
]);

/*
  Create or migrate the transcript table.

  This migration also removes the study_version column
  from the earlier test schema, if it exists.
*/
async function initialiseDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id BIGSERIAL PRIMARY KEY,

      participant_id VARCHAR(100) NOT NULL,

      condition VARCHAR(100) NOT NULL,

      transcript JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      message_count INTEGER
        NOT NULL
        DEFAULT 0,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
    );
  `);

  /*
    Remove the study-version column and any constraint
    that depended on it.
  */
  await pool.query(`
    ALTER TABLE transcripts
    DROP COLUMN IF EXISTS study_version
    CASCADE;
  `);

  /*
    Remove earlier versions of the unique constraint so
    the correct two-field constraint can be created.
  */
  await pool.query(`
    ALTER TABLE transcripts
    DROP CONSTRAINT IF EXISTS
      unique_transcript_record;
  `);

  await pool.query(`
    ALTER TABLE transcripts
    DROP CONSTRAINT IF EXISTS
      unique_participant_condition;
  `);

  /*
    Ensure there is only one stored record for each
    participant-condition combination.
  */
  await pool.query(`
    ALTER TABLE transcripts
    ADD CONSTRAINT
      unique_participant_condition
    UNIQUE (
      participant_id,
      condition
    );
  `);

  console.log(
    "PostgreSQL transcripts table is ready."
  );
}

/*
  Basic backend-status route.
*/
app.get("/", (req, res) => {
  res.send(
    "Anam experiment backend is running."
  );
});

/*
  Confirm that PostgreSQL is connected.
*/
app.get(
  "/api/health",
  async (req, res) => {
    try {
      const result =
        await pool.query(
          "SELECT NOW() AS database_time;"
        );

      res.json({
        success: true,
        databaseConnected: true,
        databaseTime:
          result.rows[0].database_time
      });
    } catch (error) {
      console.error(
        "Database health-check error:",
        error
      );

      res.status(500).json({
        success: false,
        databaseConnected: false,
        error:
          "Database connection failed."
      });
    }
  }
);

/*
  Create an Anam session token.
*/
app.post(
  "/api/session-token",
  async (req, res) => {
    try {
      const response = await fetch(
        "https://api.anam.ai/v1/auth/session-token",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${process.env.ANAM_API_KEY}`
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
                process.env
                  .ANAM_SYSTEM_PROMPT ||
                "Respond helpfully."
            }
          })
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        console.error(
          "Anam session-token error:",
          response.status,
          data
        );

        return res
          .status(response.status)
          .json(data);
      }

      res.json({
        sessionToken:
          data.sessionToken
      });
    } catch (error) {
      console.error(
        "Session-token error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to create session token."
      });
    }
  }
);

/*
  Save the latest complete transcript.

  Expected request:

  {
    participantId: "P014",
    condition: "interface_text_input_text",
    transcript: [...]
  }
*/
app.post(
  "/api/save-transcript",
  async (req, res) => {
    try {
      const {
        participantId,
        condition,
        transcript = []
      } = req.body;

      if (!participantId) {
        return res.status(400).json({
          error:
            "participantId is required."
        });
      }

      if (!condition) {
        return res.status(400).json({
          error:
            "condition is required."
        });
      }

      if (!Array.isArray(transcript)) {
        return res.status(400).json({
          error:
            "transcript must be an array."
        });
      }

      const safeParticipantId =
        String(participantId)
          .trim()
          .replace(
            /[^A-Za-z0-9_-]/g,
            ""
          )
          .slice(0, 100);

      const safeCondition =
        String(condition)
          .trim()
          .replace(
            /[^A-Za-z0-9_-]/g,
            ""
          );

      if (!safeParticipantId) {
        return res.status(400).json({
          error:
            "participantId is invalid."
        });
      }

      if (
        !validConditions.has(
          safeCondition
        )
      ) {
        return res.status(400).json({
          error:
            "Unknown experimental condition.",

          receivedCondition:
            safeCondition,

          validConditions:
            Array.from(validConditions)
        });
      }

      const saveQuery = `
        INSERT INTO transcripts (
          participant_id,
          condition,
          transcript,
          message_count,
          created_at,
          updated_at
        )

        VALUES (
          $1,
          $2,
          $3::jsonb,
          $4,
          NOW(),
          NOW()
        )

        ON CONFLICT (
          participant_id,
          condition
        )

        DO UPDATE SET
          transcript =
            EXCLUDED.transcript,

          message_count =
            EXCLUDED.message_count,

          updated_at =
            NOW()

        RETURNING
          id,
          participant_id,
          condition,
          message_count,
          created_at,
          updated_at;
      `;

      const values = [
        safeParticipantId,
        safeCondition,
        JSON.stringify(transcript),
        transcript.length
      ];

      const result =
        await pool.query(
          saveQuery,
          values
        );

      res.json({
        success: true,

        savedTranscript:
          result.rows[0]
      });
    } catch (error) {
      console.error(
        "Save-transcript error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to save transcript."
      });
    }
  }
);

/*
  List transcript summaries without returning the
  conversation content.
*/
app.get(
  "/api/transcripts",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            id,
            participant_id,
            condition,
            message_count,
            created_at,
            updated_at

          FROM transcripts

          ORDER BY
            updated_at DESC;
        `);

      res.json(result.rows);
    } catch (error) {
      console.error(
        "List-transcripts error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to list transcripts."
      });
    }
  }
);

/*
  Retrieve one complete transcript.

  Example:

  /api/transcripts/P014/interface_text_input_text
*/
app.get(
  "/api/transcripts/:participantId/:condition",
  async (req, res) => {
    try {
      const participantId =
        String(
          req.params.participantId
        )
          .trim()
          .replace(
            /[^A-Za-z0-9_-]/g,
            ""
          );

      const condition =
        String(
          req.params.condition
        )
          .trim()
          .replace(
            /[^A-Za-z0-9_-]/g,
            ""
          );

      const result =
        await pool.query(
          `
            SELECT
              id,
              participant_id,
              condition,
              transcript,
              message_count,
              created_at,
              updated_at

            FROM transcripts

            WHERE
              participant_id = $1
              AND condition = $2;
          `,
          [
            participantId,
            condition
          ]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          error:
            "Transcript not found."
        });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error(
        "Read-transcript error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to retrieve transcript."
      });
    }
  }
);

/*
  Export all complete transcripts as one JSON file.
*/
app.get(
  "/api/export-transcripts",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            participant_id,
            condition,
            transcript,
            message_count,
            created_at,
            updated_at

          FROM transcripts

          ORDER BY
            condition,
            participant_id;
        `);

      const date =
        new Date()
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
        JSON.stringify(
          result.rows,
          null,
          2
        )
      );
    } catch (error) {
      console.error(
        "Export-transcripts error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to export transcripts."
      });
    }
  }
);

const port =
  process.env.PORT || 10000;

async function startServer() {
  try {
    await initialiseDatabase();

    app.listen(
      port,
      "0.0.0.0",
      () => {
        console.log(
          `Server listening on port ${port}`
        );
      }
    );
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

process.on(
  "SIGTERM",
  shutdown
);

process.on(
  "SIGINT",
  shutdown
);
