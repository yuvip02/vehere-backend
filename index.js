import express from "express";
import cors from "cors";
import { NodeSSH } from "node-ssh";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import { EventEmitter } from "events";

EventEmitter.defaultMaxListeners = 100;

dotenv.config({ override: true });

const app = express();
app.use(cors());
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

process.on("unhandledRejection", (reason) => {
  console.error("🛑 Unhandled Rejection:", reason);
  logError(`Unhandled Rejection: ${reason}`);
});
process.on("uncaughtException", (err) => {
  console.error("🛑 Uncaught Exception:", err);
  logError(`Uncaught Exception: ${err.stack || err.message}`);
});

const sshUsername = process.env.SSH_USERNAME;
const sshPassword = process.env.SSH_PASSWORD;
const logDirPath = process.env.LOG_DIR_PATH;

const sshInstances = [];
const probes = [];
const probeData = [];
const retryCounter = {};
const retryTimestamp = {};

function logError(msg) {
  const formatted = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync("errorlogs.txt", formatted);
}

for (let i = 1; i <= 50; i++) {
  const host = process.env[`SSH_HOST${i}`];
  if (host && sshUsername && sshPassword) {
    probes.push({ host, username: sshUsername, password: sshPassword });
    probeData.push({
      ip: host,
      hostname: "Unknown",
      status: "Inactive",
      total: "0.00 Kbps",
      gbps_recv: "0 pps",
      recv_drop: "0 pps",
      sent: "0 pps",
      ports: ["-", "-", "-", "-"],
      services: { probe: "Inactive", recon: "Inactive" },
      fileCounts: {},
    });
    retryCounter[host] = 0;
    retryTimestamp[host] = 0;
  }
}

console.log(" Total probes loaded:", probes.length);
probes.forEach((p, i) => console.log(` Probe ${i + 1}: ${p.host}`));

const connectSSH = async (index) => {
  const ssh = new NodeSSH();
  sshInstances[index] = ssh;
  const host = probes[index].host;

  const now = Date.now();
  const delay = Math.min(60000, 5000 * retryCounter[host]);
  if (now - retryTimestamp[host] < delay) {
    return setTimeout(() => connectSSH(index), delay);
  }

  retryTimestamp[host] = now;

  try {
    console.log(`🔹 Connecting to SSH server ${host}...`);
    await ssh.connect({
      ...probes[index],
      keepaliveInterval: 10000,
      readyTimeout: 10000,
    });
    console.log(` SSH Connected to ${host}`);
    retryCounter[host] = 0;

    const hostname = await executeSSHCommand(index, "hostname");
    probeData[index].hostname = hostname || "Unknown";

    monitorLogs(index);
    fetchFileCounts(index);
    setInterval(() => updateServiceStatus(index), 10000);

    ssh.connection.on("close", () => reconnectSSH(index));
    ssh.connection.on("error", () => reconnectSSH(index));
  } catch (err) {
    const msg = ` SSH Connection Failed for ${host}: ${err.message}`;
    console.error(msg);
    logError(msg);

    if (++retryCounter[host] <= 5) {
      setTimeout(() => connectSSH(index), 5000);
    } else {
      logError(` Too many retries for ${host}, skipping for now.`);
    }
  }
};

const reconnectSSH = (index) => {
  const host = probes[index].host;
  logError(` SSH Disconnected from ${host}. Reconnecting...`);
  setTimeout(() => connectSSH(index), 5000);
};

const executeSSHCommand = async (index, command) => {
  const host = probes[index].host;
  try {
    if (!sshInstances[index]?.isConnected()) await connectSSH(index);
    const result = await sshInstances[index].execCommand(command);
    if (result.stderr) {
      logError(` SSH stderr on ${host}: ${result.stderr}`);
      return null;
    }
    return result.stdout.trim();
  } catch (err) {
    logError(` SSH Command Error on ${host}: ${err.message}`);
    reconnectSSH(index);
    return null;
  }
};

const fetchFileCounts = async (index) => {
  const host = probes[index].host;
  try {
    // Check if filecount.sh exists
    const fileExists = await executeSSHCommand(
      index,
      "[ -f /opt/filecount.sh ] && echo FOUND || echo NOT_FOUND"
    );
    if (fileExists !== "FOUND") {
      logError(` /opt/filecount.sh not found on ${host}`);
      return;
    }

    await new Promise((resolve) => {
      sshInstances[index].exec("/opt/filecount.sh", [], {
        onStdout(chunk) {
          const fileCounts = {};
          chunk
            .toString()
            .split("\n")
            .forEach((line) => {
              const match = line.match(/File count at (\w+): (\d+)/);
              if (match) fileCounts[match[1]] = parseInt(match[2], 10);
            });
          probeData[index].fileCounts = fileCounts;
          io.emit("probeData", probeData);
        },
        onStderr(chunk) {
          logError(` File Count Error on ${host}: ${chunk.toString()}`);
          resolve();
        },
        onError(err) {
          logError(` SSH exec error on ${host}: ${err.message}`);
          resolve();
        },
        onClose() {
          resolve();
        },
      });
    });
  } catch (err) {
    logError(` fetchFileCounts crashed on ${host}: ${err.message}`);
  }
};

const monitorLogs = async (index) => {
  const host = probes[index].host;
  try {
    await executeSSHCommand(index, `pkill -f "tail -f ${logDirPath}"`);
    const latestLog = await executeSSHCommand(
      index,
      `ls -t ${logDirPath} | head -n 1`
    );
    if (!latestLog) return;

    sshInstances[index].exec(`tail -f ${logDirPath}/${latestLog}`, [], {
      onStdout(chunk) {
        chunk
          .toString()
          .split("\n")
          .forEach((line) => parseLogLine(index, line));
      },
      onStderr(chunk) {
        logError(` Log Error on ${host}: ${chunk.toString()}`);
      },
    });
  } catch (err) {
    logError(` Log Monitor Error (${host}): ${err.message}`);
  }
};

const parseLogLine = (index, line) => {
  if (!line.trim()) return;

  const bandwidthRegex =
    /Bandwidth\s+([\d'.,]+)\s*\(\s*([\d'.,]+)?[,]?\s*([\d'.,]*)?[,]?\s*([\d'.,]*)?[,]?\s*([\d'.,]*)?\)\s*Kbps/;
  const receivedRegex = /Received\s+(\d+)\s+\(/;
  const droppedRegex = /Dropped\s+(\d+)\s+\(/;
  const sentRegex = /Sent\s+(\d+)\s+\(/;

  if (bandwidthRegex.test(line)) {
    const match = line.match(bandwidthRegex);
    const total = parseFloat(match[1].replace(/'/g, "")).toFixed(2);
    const ports = [match[2], match[3], match[4], match[5]].map((v) =>
      v ? `${parseFloat(v.replace(/'/g, "")).toFixed(2)} Kbps` : "-"
    );
    probeData[index].total = `${total} Kbps`;
    probeData[index].ports = ports;
  }

  if (receivedRegex.test(line)) {
    const match = line.match(receivedRegex);
    probeData[index].gbps_recv = match[1] + " pps";
  }

  if (droppedRegex.test(line)) {
    const match = line.match(droppedRegex);
    probeData[index].recv_drop = match[1] + " pps";
  }

  if (sentRegex.test(line)) {
    const match = line.match(sentRegex);
    probeData[index].sent = match[1] + " pps";
  }

  probeData[index].status = "Active";
  io.emit("probeData", probeData);
};

const updateServiceStatus = async (index) => {
  const host = probes[index].host;
  const ping = await executeSSHCommand(
    index,
    `ping -c 1 ${host} > /dev/null && echo Active || echo Inactive`
  );
  probeData[index].status = ping || "Inactive";

  if (ping === "Active") {
    const output = await executeSSHCommand(
      index,
      `systemctl is-active probe && systemctl is-active recon`
    );
    const [probeStatus, reconStatus] = output
      ? output.split("\n")
      : ["Inactive", "Inactive"];
    probeData[index].services.probe =
      probeStatus === "active" ? "Active" : "Inactive";
    probeData[index].services.recon =
      reconStatus === "active" ? "Active" : "Inactive";
  } else {
    probeData[index].services.probe = "Inactive";
    probeData[index].services.recon = "Inactive";
  }

  io.emit("probeData", probeData);
};

app.get("/api/log-data", (req, res) => res.json(probeData));

const PORT = 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(` Server running on http://localhost:${PORT}`);
  probes.forEach((_, index) => connectSSH(index));
});
