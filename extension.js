const vscode = require("vscode");
const { execFile } = require("node:child_process");
const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const MAX_DIFF_LENGTH = 3000;
const LOCK_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const TRUNCATE_MARK = "\n[... resto omitido ...]\n";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function truncateDiff(diff, maxLength) {
  if (diff.length <= maxLength) return diff;
  const headLength = Math.floor(maxLength * 0.6);
  const tailMaxLength = maxLength - headLength - TRUNCATE_MARK.length;
  return (
    diff.slice(0, headLength) +
    TRUNCATE_MARK +
    diff.slice(diff.length - tailMaxLength)
  );
}

function getRetryDelay(response, body) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const seconds = body?.error?.message?.match(/in ([\d.]+)s/)?.[1];
  if (seconds) return Math.ceil(Number(seconds)) * 1000;
  return 5000;
}

const PROMPT = `Genera un mensaje de commit breve pero específico en español que describa exactamente lo que se hizo según el diff. Empieza en minúscula y sin prefijos como fix:, feat: o similares. Nombra la acción concreta y el elemento real modificado (archivo, función o símbolo) usando su nombre original entre backticks. Basa el mensaje solo en el diff: no inventes cambios, no uses frases genéricas o vagas ni menciones el propósito, motivo, resultado o 'para'. Si hay varios cambios, menciona el principal o los dos más relevantes. Usa mayúsculas solo donde corresponda. Ejemplo: agrega validación de email en \`form.ts\`. Devuelve únicamente el mensaje.

Diff:
`;

async function activate(context) {
  const command = vscode.commands.registerCommand("spanishCommit.generate", async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: "Generando commit..."
      },
      generateCommit
    );
  });

  context.subscriptions.push(command);

  const bumpCommand = vscode.commands.registerCommand(
    "spanishCommit.bumpVersion",
    bumpVersion
  );

  context.subscriptions.push(bumpCommand);
}

async function generateCommit() {
  try {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) {
      throw new Error("La extensión Git de VS Code no está disponible.");
    }

    const git = gitExtension.isActive
      ? gitExtension.exports.getAPI(1)
      : (await gitExtension.activate()).getAPI(1);
    const repository = git.repositories[0];

    if (!repository) {
      throw new Error("No hay un repositorio Git abierto.");
    }

    const cwd = repository.rootUri.fsPath;
    const apiKey = await resolveApiKey(cwd);
    if (!apiKey) {
      throw new Error(
        "Configura GROQ_API_KEY en el .env del repositorio y recarga VS Code."
      );
    }
    let { stdout: diff } = await execFileAsync(
      "git",
      [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--",
        ".",
        ":(exclude)package-lock.json",
        ":(exclude)yarn.lock",
        ":(exclude)pnpm-lock.yaml"
      ],
      { cwd, maxBuffer: 5 * 1024 * 1024 }
    );

    if (!diff.trim()) {
      ({ stdout: diff } = await execFileAsync(
        "git",
        [
          "diff",
          "--no-ext-diff",
          "--",
          ".",
          ":(exclude)package-lock.json",
          ":(exclude)yarn.lock",
          ":(exclude)pnpm-lock.yaml"
        ],
        { cwd, maxBuffer: 5 * 1024 * 1024 }
      ));
    }

    if (!diff.trim()) {
      const { stdout: untracked } = await execFileAsync(
        "git",
        ["ls-files", "--others", "--exclude-standard"],
        { cwd, maxBuffer: 5 * 1024 * 1024 }
      );
      const files = untracked.split(/\r?\n/).filter(Boolean);
      const contents = [];

      for (const file of files) {
        if (LOCK_FILE.test(file)) {
          contents.push(`--- /dev/null\n+++ b/${file}\n[archivo lock omitido]`);
          continue;
        }

        try {
          const content = await readFile(path.join(cwd, file), "utf8");
          contents.push(
            `--- /dev/null\n+++ b/${file}\n${content.slice(0, 3000)}`
          );
        } catch {
          contents.push(`--- /dev/null\n+++ b/${file}\n[archivo binario]`);
        }
      }

      diff = contents.join("\n\n");
    }

    if (!diff.trim()) {
      throw new Error("No hay cambios para generar el commit.");
    }

    const bodyJson = JSON.stringify({
      model: "qwen/qwen3.8-27b",
      stream: false,
      max_tokens: 256,
      temperature: 1,
      top_p: 1,
      reasoning_effort: "none",
      messages: [
        {
          role: "system",
          content: "Generas mensajes de commit claros y breves."
        },
        {
          role: "user",
          content: PROMPT + truncateDiff(diff, MAX_DIFF_LENGTH)
        }
      ]
    });

    let response;
    let body;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: bodyJson
      });
      body = await response.json();
      if (response.ok || response.status !== 429) {
        break;
      }
      await sleep(getRetryDelay(response, body));
    }

    if (!response.ok) {
      throw new Error(
        body.error?.message ||
          body.message ||
          `Groq respondió ${response.status}: ${JSON.stringify(body)}`
      );
    }

    const message = extractMessageContent(body.choices?.[0]);
    if (!message) {
      throw new Error("Groq no devolvió un mensaje.");
    }

    repository.inputBox.value = message.replace(/^['"]|['"]$/g, "");
  } catch (error) {
    vscode.window.showErrorMessage(`No se pudo generar el commit: ${error.message}`);
  }
}

async function getWindowsUserEnvironmentVariable(name) {
  if (process.platform !== "win32") {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync("reg.exe", [
      "query",
      "HKCU\\Environment",
      "/v",
      name
    ]);
    return stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

async function resolveApiKey(cwd) {
  if (process.env.GROQ_API_KEY) {
    return process.env.GROQ_API_KEY;
  }

  const fromRegistry = await getWindowsUserEnvironmentVariable("GROQ_API_KEY");
  if (fromRegistry) {
    return fromRegistry;
  }

  for (const fileName of [".env", ".env.local"]) {
    try {
      const content = await readFile(path.join(cwd, fileName), "utf8");
      const match = content.match(
        /^\s*GROQ_API_KEY\s*=\s*(".*?"|'.*?'|[^\s#]+)/m
      );
      if (match) {
        return match[1].replace(/^["']|["']$/g, "");
      }
    } catch {
      // el archivo no existe
    }
  }

  return undefined;
}

function extractMessageContent(choice) {
  const raw = choice?.message?.content;
  let text = "";
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .map((part) => (typeof part === "string" ? part : part?.text))
      .filter(Boolean)
      .join("");
  }
  if (text.trim()) {
    return text.trim();
  }

  const reasoning = choice?.message?.reasoning;
  return typeof reasoning === "string" && reasoning.trim()
    ? reasoning.trim()
    : undefined;
}

async function bumpVersion() {
  try {
    const cwd = await getRepositoryRoot();
    if (!cwd) {
      throw new Error("No hay un repositorio ni una carpeta abierta.");
    }

    const packageJsonPath = path.join(cwd, "package.json");
    const content = await readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(content);
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version || "")) {
      throw new Error(
        `package.json no tiene una versión x.y.z válida (actual: ${pkg.version}).`
      );
    }

    const parts = pkg.version.split(".").map(Number);
    parts[2] += 1;
    const newVersion = parts.join(".");
    pkg.version = newVersion;
    await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

    vscode.window.showInformationMessage(
      `Versión actualizada a ${newVersion} en package.json.`
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `No se pudo subir la versión: ${error.message}`
    );
  }
}

async function getRepositoryRoot() {
  const gitExtension = vscode.extensions.getExtension("vscode.git");
  if (gitExtension) {
    const git = gitExtension.isActive
      ? gitExtension.exports.getAPI(1)
      : (await gitExtension.activate()).getAPI(1);
    const repository = git.repositories[0];
    if (repository) {
      return repository.rootUri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function deactivate() {}

module.exports = { activate, deactivate };
