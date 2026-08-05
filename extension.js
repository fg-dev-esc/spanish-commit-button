const vscode = require("vscode");
const { execFile } = require("node:child_process");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const MAX_DIFF_LENGTH = 12000;
const LOCK_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

const PROMPT = `Genera un mensaje de commit muy corto y concreto en español que empiece en minúscula, sin prefijos como fix:, feat: o similares. Menciona solo la acción y el elemento modificado; no expliques el propósito, motivo, resultado ni agregues frases con 'para'. Usa mayúsculas solo cuando correspondan y conserva la escritura original de nombres técnicos. Mantén en inglés los archivos, funciones y elementos del código, y escríbelos entre backticks. Ejemplo: actualiza el título en \`index.html\`. Devuelve únicamente el mensaje.

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
}

async function generateCommit() {
  try {
    const apiKey = process.env.CEREBRAS_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Configura la variable CEREBRAS_API_KEY y reinicia VS Code."
      );
    }

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

    const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-oss-120b",
        stream: false,
        max_tokens: 1000,
        temperature: 1,
        top_p: 1,
        reasoning_effort: "low",
        messages: [
          {
            role: "system",
            content: "Generas mensajes de commit claros y breves."
          },
          {
            role: "user",
            content: PROMPT + diff.slice(0, MAX_DIFF_LENGTH)
          }
        ]
      })
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(
        body.error?.message ||
          body.message ||
          `Cerebras respondió ${response.status}: ${JSON.stringify(body)}`
      );
    }

    const message = body.choices?.[0]?.message?.content?.trim();
    if (!message) {
      throw new Error("Cerebras no devolvió un mensaje.");
    }

    repository.inputBox.value = message.replace(/^['"]|['"]$/g, "");
  } catch (error) {
    vscode.window.showErrorMessage(`No se pudo generar el commit: ${error.message}`);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
