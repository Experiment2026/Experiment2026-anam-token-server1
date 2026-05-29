import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

const app = express();

app.use(express.json({ limit: "10mb" }));

const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://experiment2026.github.io";

app.use(cors({
  origin: allowedOrigin
}));

const transcriptsDir = path.join(process.cwd(), "transcripts");

if (!fs.existsSync(transcriptsDir)) {
  fs.mkdirSync(transcriptsDir);
}

app.get("/", (req, res) => {
  res.send("Anam token server is running.");
});

app.post("/api/session-token", async (req, res) => {
  try {
    const response = await fetch("https://api.anam.ai/v1/auth/session-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.ANAM_API_KEY}`,
      },
      body: JSON.stringify({
        personaConfig: {
          name: process.env.PERSONA_NAME || "Study Agent",
          avatarId: process.env.ANAM_AVATAR_ID,
          voiceId: process.env.ANAM_VOICE_ID,
          llmId: process.env.ANAM_LLM_ID,
          systemPrompt: process.env.ANAM_SYSTEM_PROMPT || "Respond helpfully."
        }
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json({ sessionToken: data.sessionToken });
  } catch (error) {
    console.error("Session token error:", error);
    res.status(500).json({ error: "Failed to create session token." });
  }
});

app.post("/api/save-transcript", (req, res) => {
  try {
    const {
      participantId = "unknown",
      condition = "unknown",
      transcript = []
    } = req.body;

    const safeParticipantId = String(participantId).replace(/[^a-zA-Z0-9_-]/g, "");
    const safeCondition = String(condition).replace(/[^a-zA-Z0-9_-]/g, "");

    const filename = `${Date.now()}_${safeParticipantId}_${safeCondition}.json`;
    const filepath = path.join(transcriptsDir, filename);

    const dataToSave = {
      participantId: safeParticipantId,
      condition: safeCondition,
      savedAt: new Date().toISOString(),
      transcript
    };

    fs.writeFileSync(filepath, JSON.stringify(dataToSave, null, 2));

    res.json({
      success: true,
      filename
    });
  } catch (error) {
    console.error("Save transcript error:", error);
    res.status(500).json({ error: "Failed to save transcript." });
  }
});

// List transcript files
app.get("/api/transcripts", (req, res) => {
  try {
    const files = fs.readdirSync(transcriptsDir);
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: "Failed to list transcripts." });
  }
});

// View/download one transcript file
app.get("/api/transcripts/:filename", (req, res) => {
  try {
    const filename = req.params.filename;

    // Basic safety check
    if (!filename.endsWith(".json") || filename.includes("..") || filename.includes("/")) {
      return res.status(400).json({ error: "Invalid filename." });
    }

    const filepath = path.join(transcriptsDir, filename);

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: "File not found." });
    }

    res.sendFile(filepath);
  } catch (error) {
    console.error("Read transcript error:", error);
    res.status(500).json({ error: "Failed to read transcript." });
  }
});

const port = process.env.PORT || 10000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
