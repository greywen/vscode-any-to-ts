import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
  Uri,
  ExtensionContext,
  commands,
  env,
  ViewColumn,
  window,
  workspace,
  StatusBarAlignment,
  ConfigurationTarget,
} from 'vscode';
import JsonToTS from 'json-to-ts';
import OpenAI from 'openai';

const SYSTEM_PROMPT = `Converts any string entered into a TypeScript type, using a type alias. 
Rules: 
1. Only return TypeScript type definitions in plain text format. Do not return to markdown format, Do not include any explanations, descriptions, code comments, sample code, or other text except the type definition itself. 
2. If the input string cannot be understood, or cannot be converted to a valid TypeScript type, An empty interface RootObject { } or type RootObject = { } definition. 
3. if conversion is possible, return only the converted type, using the {{useTypeAlias}} alias.`;

const statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 100);

export function activate(context: ExtensionContext) {
  context.subscriptions.push(
    commands.registerCommand('anyToTs.fromClipboard', transformFromClipboard)
  );
  context.subscriptions.push(
    commands.registerCommand('anyToTs.fromSelection', transformFromSelection)
  );
  context.subscriptions.push(
    commands.registerCommand('anyToTs.fromTransform', transformFromTransform)
  );
}

function getUseTypeAlias() {
  const config = workspace.getConfiguration('greywen.any-to-ts');
  return config.get<boolean>('useTypeAlias');
}

function getLLMConfig() {
  const config = workspace.getConfiguration('greywen.any-to-ts');
  return {
    baseURL: config.get<string>('baseURL') || '',
    apiKey: config.get<string>('apiKey') || '',
    modelName: config.get<string>('modelName') || ''
  };
}

function getUseLLM() {
  const config = workspace.getConfiguration('greywen.any-to-ts');
  return config.get<boolean>('useLLM');
}

async function useJSONToTS(text: string) {
  return await Promise.resolve(text)
    .then(validateLength)
    .then(parseJson)
    .then((json) => {
      return JsonToTS(json, { useTypeAlias: getUseTypeAlias() }).reduce(
        (a, b) => `${a}\n\n${b}`
      );
    });
}

async function useLLM(text: string) {
  return await Promise.resolve(text).then(validateLength).then(text => transformAnyToTS(text));
}

async function conversion(text: string) {
  let result = '';
  statusBarItem.text = '$(sync~spin) Loading...';
  statusBarItem.show();
  try {
    try {
      result = await useJSONToTS(text);
    } catch (error: any) {
      if (getUseLLM()) result = await useLLM(text);
      else handleError(error)
    }
    return result;
  } catch (error) {
    return Promise.reject(error);
  } finally {
    statusBarItem.hide();
  }
}

async function transformFromSelection() {
  const tmpFilePath = path.join(os.tmpdir(), 'any-to-ts.ts');
  const tmpFileUri = Uri.file(tmpFilePath);
  const text = await getSelectedText();

  conversion(text)
    .then((interfaces) => {
      fs.writeFileSync(tmpFilePath, interfaces);
    })
    .then(() => {
      commands.executeCommand('vscode.open', tmpFileUri, getViewColumn());
    })
    .catch(handleError);
}

async function transformFromClipboard() {
  const text = await env.clipboard.readText();

  conversion(text)
    .then((interfaces) => {
      pasteToMarker(interfaces);
    })
    .catch(handleError);
}

function transformFromTransform() {
  const useTypeAlias = !getUseTypeAlias();
  workspace.getConfiguration().update(
    'greywen.any-to-ts.useTypeAlias',
    useTypeAlias,
    ConfigurationTarget.Global
  );
  window.showInformationMessage(useTypeAlias ? 'Use Type alias.' : 'Use Interface alias.')
}

function handleError(error: Error) {
  window.showErrorMessage(error.message);
}

function parseJson(json: string): Promise<object> {
  const tryEval = (str: any) => eval(`const a = ${str}; a`);

  try {
    return Promise.resolve(JSON.parse(json));
    // eslint-disable-next-line no-empty
  } catch (ignored) { }

  try {
    return Promise.resolve(tryEval(json));
  } catch (error) {
    return Promise.reject(new Error("Selected string is not a valid JSON"));
  }
}

function getViewColumn(): ViewColumn {
  const activeEditor = window.activeTextEditor;
  if (!activeEditor) {
    return ViewColumn.One;
  }

  switch (activeEditor.viewColumn) {
    case ViewColumn.One:
      return ViewColumn.Two;
    case ViewColumn.Two:
      return ViewColumn.Three;
  }

  return activeEditor.viewColumn as any;
}

function pasteToMarker(content: string) {
  const { activeTextEditor } = window;

  return activeTextEditor?.edit((editBuilder) => {
    editBuilder.replace(activeTextEditor.selection, content);
  });
}

function getSelectedText(): Promise<string> {
  const { selection, document } = window.activeTextEditor!;
  return Promise.resolve(document.getText(selection).trim());
}

function validateLength(text: string) {
  if (text.length === 0) {
    return Promise.reject(new Error('Nothing selected'));
  } else {
    return Promise.resolve(text);
  }
}

async function transformAnyToTS(text: string) {
  const config = getLLMConfig();
  const openAIClient = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  try {
    const data = await openAIClient.chat.completions.create({
      stream: false,
      model: config.modelName,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT.replace(/{{useTypeAlias}}/g, getUseTypeAlias() ? 'type' : 'interface') },
        { role: 'user', content: text },
      ],
    });
    return data.choices[0].message.content || '{}';
  } catch (err) {
    let errMsg = '';
    if (typeof err === 'string') {
      errMsg = err;
    } else if (typeof err === 'object') {
      errMsg = JSON.stringify(err);
    }
    window.showErrorMessage(errMsg);
  }
  return '';
}
