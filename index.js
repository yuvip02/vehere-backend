import express from "express";
import cors from "cors";
import { NodeSSH } from "node-ssh";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";

dotenv.config();

const app = express();
app.use(cors());
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// **Multi-Probe Configuration**
const probes = [
  {
    host: process.env.SSH_HOST1,
    username: process.env.SSH_USERNAME1,
    password: process.env.SSH_PASSWORD1,
  },
  {
    host: process.env.SSH_HOST2,
    username: process.env.SSH_USERNAME2,
    password: process.env.SSH_PASSWORD2,
  },
  // Add more probes dynamically if needed
];

const logDirPath = process.env.LOG_DIR_PATH;
const sshInstances = [];
const probeData = probes.map((probe) => ({
  ip: probe.host,
  hostname: "Unknown",
  status: "Inactive",
  total: "0.00 Kbps",
  gbps_recv: "0 pps",
  recv_drop: "0 pps",
  sent: "0 pps",
  ports: ["-", "-", "-", "-"],
  services: { probe: "Inactive", recon: "Inactive" },
  fileCounts: {},
}));

// **🔄 SSH Connection with Backoff Retry**
const connectSSH = async (index) => {
  const ssh = new NodeSSH();
  sshInstances[index] = ssh;

  console.log(`🔹 Connecting to SSH server ${probes[index].host}...`);
  try {
    await ssh.connect({
      ...probes[index],
      keepaliveInterval: 10000,
      readyTimeout: 60000,
    });

    console.log(`✅ SSH Connected to ${probes[index].host}!`);
    probeData[index].hostname = await executeSSHCommand(index, "hostname");

    // **Monitor Logs & Fetch Data**
    monitorLogs(index);
    fetchFileCounts(index);
    setInterval(() => updateServiceStatus(index), 10000);

    ssh.connection.on("close", () => reconnectSSH(index));
    ssh.connection.on("error", () => reconnectSSH(index));
  } catch (error) {
    console.error(`❌ SSH Connection Failed for ${probes[index].host}:`, error);
    setTimeout(() => connectSSH(index), 5000);
  }
};

const reconnectSSH = (index) => {
  console.log(
    `⚠️ SSH Disconnected from ${probes[index].host}. Reconnecting...`
  );
  setTimeout(() => connectSSH(index), 5000);
};

// **🔹 Execute SSH Commands Efficiently**
const executeSSHCommand = async (index, command) => {
  if (!sshInstances[index].isConnected()) {
    console.warn(
      `⚠️ SSH Disconnected from ${probes[index].host}, reconnecting...`
    );
    await connectSSH(index);
  }

  try {
    console.log(
      `🔹 Executing SSH Command on ${probes[index].host}: ${command}`
    );
    const result = await sshInstances[index].execCommand(command);

    if (result.stderr) {
      console.warn("⚠️ SSH Command Error:", result.stderr);
      return null;
    }

    return result.stdout.trim();
  } catch (error) {
    console.error("❌ SSH Command Execution Failed:", error);
    reconnectSSH(index);
    return null;
  }
};

// **📡 Monitor File Counts from /opt/filecount.sh**
const fetchFileCounts = async (index) => {
  console.log(`📡 Fetching file counts for ${probes[index].host}...`);

  sshInstances[index].exec("/opt/filecount.sh", [], {
    onStdout(chunk) {
      const output = chunk.toString();
      console.log(`📜 File Count Update for ${probes[index].host}:\n`, output);

      const fileCounts = {};
      output.split("\n").forEach((line) => {
        const match = line.match(/File count at (\w+): (\d+)/);
        if (match) {
          fileCounts[match[1]] = parseInt(match[2], 10);
        }
      });

      probeData[index].fileCounts = fileCounts;
      io.emit("probeData", probeData);
    },
    onStderr(chunk) {
      console.error("❌ Error Fetching File Counts:", chunk.toString());
    },
  });
};

// **📡 Monitor Logs for Each Probe**
const monitorLogs = async (index) => {
  console.log(`📡 Monitoring logs for ${probes[index].host}...`);
  try {
    await executeSSHCommand(index, `pkill -f "tail -f ${logDirPath}"`);

    const latestLog = await executeSSHCommand(
      index,
      `ls -t ${logDirPath} | head -n 1`
    );
    if (!latestLog) {
      console.error(`❌ No log file found on ${probes[index].host}.`);
      return;
    }

    const latestLogFile = `${logDirPath}/${latestLog}`;
    console.log(
      `📂 Monitoring log file: ${latestLogFile} on ${probes[index].host}`
    );

    sshInstances[index].exec(`tail -f ${latestLogFile}`, [], {
      onStdout(chunk) {
        chunk
          .toString()
          .split("\n")
          .forEach((line) => parseLogLine(index, line));
      },
      onStderr(chunk) {
        console.error("❌ Log Stream Error:", chunk.toString());
      },
    });
  } catch (error) {
    console.error(`❌ Error monitoring logs on ${probes[index].host}:`, error);
  }
};

// **🔹 Parse Log Lines for Each Probe**
const parseLogLine = (index, line) => {
  if (!line.trim()) return;

  console.log(`🔍 Raw Log Line from ${probes[index].host}:`, line);

  const bandwidthRegex =
    /Bandwidth\s+([\d'.,]+)\s*\(\s*([\d'.,]+)?,?\s*([\d'.,]*)?,?\s*([\d'.,]*)?,?\s*([\d'.,]*)?\)\s*Kbps/;
  const receivedRegex =
    /Received\s+(\d+)\s+\(\s*([\d'.,]+),?\s*([\d'.,]*)\)\s+pps/;
  const droppedRegex =
    /Dropped\s+(\d+)\s+\(\s*([\d'.,]+),?\s*([\d'.,]*)\)\s+pps/;
  const sentRegex = /Sent\s+(\d+)\s+\(\s*([\d'.,]+),?\s*([\d'.,]*)\)\s+pps/;

  if (bandwidthRegex.test(line)) {
    const match = line.match(bandwidthRegex);
    if (!match) {
      console.warn(
        `⚠️ Bandwidth regex matched but failed to extract values:`,
        line
      );
      return;
    }

    const totalBandwidth = match[1]
      ? parseFloat(match[1].replace(/'/g, "")).toFixed(2)
      : "0.00";
    const port1 = match[2]
      ? parseFloat(match[2].replace(/'/g, "")).toFixed(2)
      : "-";
    const port2 = match[3]
      ? parseFloat(match[3].replace(/'/g, "")).toFixed(2)
      : "-";
    const port3 = match[4]
      ? parseFloat(match[4].replace(/'/g, "")).toFixed(2)
      : "-";
    const port4 = match[5]
      ? parseFloat(match[5].replace(/'/g, "")).toFixed(2)
      : "-";

    probeData[index].total = `${totalBandwidth} Kbps`;
    probeData[index].ports = [port1, port2, port3, port4].map((port) =>
      port === "-" ? "-" : `${port} Kbps`
    );

    console.log(
      `✅ Updated Bandwidth for ${probes[index].host}:`,
      probeData[index].total,
      probeData[index].ports
    );
  }

  if (receivedRegex.test(line)) {
    const match = line.match(receivedRegex);
    probeData[index].gbps_recv = match[1] ? `${match[1]} pps` : "-";
  }

  if (droppedRegex.test(line)) {
    const match = line.match(droppedRegex);
    probeData[index].recv_drop = match[1] ? `${match[1]} pps` : "-";
  }

  if (sentRegex.test(line)) {
    const match = line.match(sentRegex);
    probeData[index].sent = match[1] ? `${match[1]} pps` : "-";
  }

  probeData[index].status = "Active";
  io.emit("probeData", probeData);
};

// **🔄 Update Service Status for Each Probe**
const updateServiceStatus = async (index) => {
  const statusOutput = await executeSSHCommand(
    index,
    `ping -c 1 ${probeData[index].ip} > /dev/null && echo "Active" || echo "Inactive"`
  );

  probeData[index].status = statusOutput || "Inactive";

  if (probeData[index].status === "Active") {
    const serviceOutput = await executeSSHCommand(
      index,
      `systemctl is-active probe && systemctl is-active recon`
    );
    const [probeStatus, reconStatus] = serviceOutput.split("\n");

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

// **📡 API Endpoint for Multiple Probes**
app.get("/api/log-data", (req, res) => {
  res.json(probeData);
});

// **🚀 Start Backend Server**
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  probes.forEach((_, index) => connectSSH(index));
});
