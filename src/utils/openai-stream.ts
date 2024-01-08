import {
  AIStream,
  trimStartOfStreamHelper,
  type AIStreamCallbacksAndOptions,
  FunctionCallPayload,
  readableFromAsyncIterable,
  createCallbacksTransformer,
  createStreamDataTransformer,
  CreateMessage, JSONValue, createChunkDecoder
} from 'ai'

export type StreamString =
  `${(typeof StreamStringPrefixes)[keyof typeof StreamStringPrefixes]}:${string}\n`

export const StreamStringPrefixes = {
  text: 0,
  function_call: 1,
  data: 2
  // user_err: 3?
} as const
const getStreamString = (
  type: keyof typeof StreamStringPrefixes,
  value: JSONValue
): StreamString => `${StreamStringPrefixes[type]}:${JSON.stringify(value)}\n`

export type OpenAIStreamCallbacks = AIStreamCallbacksAndOptions & {
  /**
   * @example
   * ```js
   * const response = await openai.chat.completions.create({
   *   model: 'gpt-3.5-turbo-0613',
   *   stream: true,
   *   messages,
   *   functions,
   * })
   *
   * const stream = OpenAIStream(response, {
   *   experimental_onFunctionCall: async (functionCallPayload, createFunctionCallMessages) => {
   *     // ... run your custom logic here
   *     const result = await myFunction(functionCallPayload)
   *
   *     // Ask for another completion, or return a string to send to the client as an assistant message.
   *     return await openai.chat.completions.create({
   *       model: 'gpt-3.5-turbo-0613',
   *       stream: true,
   *       // Append the relevant "assistant" and "function" call messages
   *       messages: [...messages, ...createFunctionCallMessages(result)],
   *       functions,
   *     })
   *   }
   * })
   * ```
   */
  experimental_onFunctionCall?: (
    functionCallPayload: FunctionCallPayload,
    createFunctionCallMessages: (
      functionCallResult: JSONValue
    ) => CreateMessage[]
  ) => Promise<
    Response | undefined | void | string | AsyncIterableOpenAIStreamReturnTypes
  >
}

// https://github.com/openai/openai-node/blob/07b3504e1c40fd929f4aae1651b83afc19e3baf8/src/resources/chat/completions.ts#L28-L40
interface ChatCompletionChunk {
  id: string
  choices: Array<ChatCompletionChunkChoice>
  created: number
  model: string
  object: string
  conversation_id?: string
  parent_message_id?: string
}

// https://github.com/openai/openai-node/blob/07b3504e1c40fd929f4aae1651b83afc19e3baf8/src/resources/chat/completions.ts#L43-L49
interface ChatCompletionChunkChoice {
  delta: ChoiceDelta

  finish_reason: 'stop' | 'length' | 'function_call' | null

  index: number
}

// https://github.com/openai/openai-node/blob/07b3504e1c40fd929f4aae1651b83afc19e3baf8/src/resources/chat/completions.ts#L123-L139
interface ChoiceDelta {
  /**
   * The contents of the chunk message.
   */
  content?: string | null

  /**
   * The name and arguments of a function that should be called, as generated by the
   * model.
   */
  function_call?: FunctionCall

  /**
   * The role of the author of this message.
   */
  role?: 'system' | 'user' | 'assistant' | 'function'
}

// https://github.com/openai/openai-node/blob/07b3504e1c40fd929f4aae1651b83afc19e3baf8/src/resources/chat/completions.ts#L146-L159
interface FunctionCall {
  /**
   * The arguments to call the function with, as generated by the model in JSON
   * format. Note that the model does not always generate valid JSON, and may
   * hallucinate parameters not defined by your function schema. Validate the
   * arguments in your code before calling your function.
   */
  arguments?: string

  /**
   * The name of the function to call.
   */
  name?: string
}

/**
 * https://github.com/openai/openai-node/blob/3ec43ee790a2eb6a0ccdd5f25faa23251b0f9b8e/src/resources/completions.ts#L28C1-L64C1
 * Completions API. Streamed and non-streamed responses are the same.
 */
interface Completion {
  /**
   * A unique identifier for the completion.
   */
  id: string

  /**
   * The list of completion choices the model generated for the input prompt.
   */
  choices: Array<CompletionChoice>

  /**
   * The Unix timestamp of when the completion was created.
   */
  created: number

  /**
   * The model used for completion.
   */
  model: string

  /**
   * The object type, which is always "text_completion"
   */
  object: string


  conversation_id?: string
  parent_message_id?: string

}

interface CompletionChoice {
  /**
   * The reason the model stopped generating tokens. This will be `stop` if the model
   * hit a natural stop point or a provided stop sequence, or `length` if the maximum
   * number of tokens specified in the request was reached.
   */
  finish_reason: 'stop' | 'length'

  index: number


  // edited: Removed CompletionChoice.logProbs and replaced with any
  logprobs: any | null

  text: string

  delta: { content: string }
}

/**
 * Creates a parser function for processing the OpenAI stream data.
 * The parser extracts and trims text content from the JSON data. This parser
 * can handle data for chat or completion models.
 *
 * @return {(data: string) => string | void} A parser function that takes a JSON string as input and returns the extracted text content or nothing.
 */
function parseOpenAIStream(): (data: string) => string | void {
  const extract = chunkToText()
  return data => {
    return extract(JSON.parse(data) as OpenAIStreamReturnTypes)
  }
}


function isChatCompletionChunk(
  data: OpenAIStreamReturnTypes
): data is ChatCompletionChunk {
  return (
    'choices' in data &&
    data.choices &&
    data.choices[0] &&
    'delta' in data.choices[0]
  )
}

function isCompletion(data: OpenAIStreamReturnTypes): data is Completion {
  return (
    'choices' in data &&
    data.choices &&
    data.choices[0] &&
    'text' in data.choices[0]
  )
}

const __internal__OpenAIFnMessagesSymbol = Symbol('internal_openai_fn_messages')

function createFunctionCallTransformer(
  callbacks: OpenAIStreamCallbacks & {
    [__internal__OpenAIFnMessagesSymbol]?: CreateMessage[]
  }
): TransformStream<Uint8Array, Uint8Array> {

  const textEncoder = new TextEncoder()
  let isFirstChunk = true
  let aggregatedResponse = ''
  let aggregatedFinalCompletionResponse = ''
  let isFunctionStreamingIn = false

  let functionCallMessages: CreateMessage[] =
    callbacks[__internal__OpenAIFnMessagesSymbol] || []

  const isComplexMode = callbacks?.experimental_streamData
  const decode = createChunkDecoder()

  return new TransformStream({
    async transform(chunk, controller): Promise<void> {
      const message = decode(chunk)
      aggregatedFinalCompletionResponse += message
      console.log('message',message);
      

      const shouldHandleAsFunction =
        isFirstChunk && message.startsWith('{"function_call":')

      if (shouldHandleAsFunction) {
        isFunctionStreamingIn = true
        aggregatedResponse += message
        isFirstChunk = false
        return
      }

      // Stream as normal
      if (!isFunctionStreamingIn) {
        controller.enqueue(
          isComplexMode
            ? textEncoder.encode(getStreamString('text', message))
            : chunk
        )
        return
      } else {
        aggregatedResponse += message
      }
    },
    async flush(controller): Promise<void> {
      try {
        const isEndOfFunction =
          !isFirstChunk &&
          callbacks.experimental_onFunctionCall &&
          isFunctionStreamingIn

        // This callbacks.experimental_onFunctionCall check should not be necessary but TS complains
        if (isEndOfFunction && callbacks.experimental_onFunctionCall) {
          isFunctionStreamingIn = false
          const payload = JSON.parse(aggregatedResponse)
          const argumentsPayload = JSON.parse(payload.function_call.arguments)

          // Append the function call message to the list
          let newFunctionCallMessages: CreateMessage[] = [
            ...functionCallMessages
          ]

          const functionResponse = await callbacks.experimental_onFunctionCall(
            {
              name: payload.function_call.name,
              arguments: argumentsPayload
            },
            result => {
              // Append the function call request and result messages to the list
              newFunctionCallMessages = [
                ...functionCallMessages,
                {
                  role: 'assistant',
                  content: '',
                  function_call: payload.function_call
                },
                {
                  role: 'function',
                  name: payload.function_call.name,
                  content: JSON.stringify(result)
                }
              ]

              // Return it to the user
              return newFunctionCallMessages
            }
          )

          if (!functionResponse) {
            // The user didn't do anything with the function call on the server and wants
            // to either do nothing or run it on the client
            // so we just return the function call as a message
            controller.enqueue(
              textEncoder.encode(
                isComplexMode
                  ? getStreamString('function_call', aggregatedResponse)
                  : aggregatedResponse
              )
            )
            return
          } else if (typeof functionResponse === 'string') {
            // The user returned a string, so we just return it as a message
            controller.enqueue(
              isComplexMode
                ? textEncoder.encode(getStreamString('text', functionResponse))
                : textEncoder.encode(functionResponse)
            )
            return
          }

          // Recursively:

          // We don't want to trigger onStart or onComplete recursively
          // so we remove them from the callbacks
          // see https://github.com/vercel/ai/issues/351
          const filteredCallbacks: OpenAIStreamCallbacks = {
            ...callbacks,
            onStart: undefined
          }
          // We only want onFinal to be called the _last_ time
          callbacks.onFinal = undefined

          const openAIStream = OpenAIStream(functionResponse, {
            ...filteredCallbacks,
            [__internal__OpenAIFnMessagesSymbol]: newFunctionCallMessages
          } as AIStreamCallbacksAndOptions)

          const reader = openAIStream.getReader()

          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              break
            }
            controller.enqueue(value)
          }
        }
      } finally {
        if (callbacks.onFinal && aggregatedFinalCompletionResponse) {
          await callbacks.onFinal(aggregatedFinalCompletionResponse)
        }
      }
    }
  })
}

/**
 * Reads chunks from OpenAI's new Streamable interface, which is essentially
 * the same as the old Response body interface with an included SSE parser
 * doing the parsing for us.
 */

function chunkToText(): (chunk: OpenAIStreamReturnTypes) => string | void {
  const trimStartOfStream = trimStartOfStreamHelper()
  let isFunctionStreamingIn: boolean
  return json => {
    if (
      isChatCompletionChunk(json) &&
      json.choices[0]?.delta?.function_call?.name
    ) {
      isFunctionStreamingIn = true
      return `{"function_call": {"name": "${json.choices[0]?.delta?.function_call.name}", "arguments": "`
    } else if (
      isChatCompletionChunk(json) &&
      json.choices[0]?.delta?.function_call?.arguments
    ) {
      const argumentChunk: string =
        json.choices[0].delta.function_call.arguments

      let escapedPartialJson = argumentChunk
        .replace(/\\/g, '\\\\') // Replace backslashes first to prevent double escaping
        .replace(/\//g, '\\/') // Escape slashes
        .replace(/"/g, '\\"') // Escape double quotes
        .replace(/\n/g, '\\n') // Escape new lines
        .replace(/\r/g, '\\r') // Escape carriage returns
        .replace(/\t/g, '\\t') // Escape tabs
        .replace(/\f/g, '\\f') // Escape form feeds

      return `${escapedPartialJson}`
    } else if (
      isFunctionStreamingIn &&
      (json.choices[0]?.finish_reason === 'function_call' ||
        json.choices[0]?.finish_reason === 'stop')
    ) {
      isFunctionStreamingIn = false // Reset the flag
      return '"}}'
    }
    let content
    const cp:OpenAIStreamReturnTypes = JSON.parse(JSON.stringify(json))
    if (json.conversation_id && json.parent_message_id) {
      content = `${json.choices[0].delta.content} {"conversation_id":"${json.conversation_id}","parent_message_id":"${json.parent_message_id}"}`
    } else {
      content = json.choices[0].delta.content
    }
    cp.choices[0].delta.content = content



    const text = trimStartOfStream(
      isChatCompletionChunk(cp) && cp.choices[0].delta.content
        ? cp.choices[0].delta.content
        : isCompletion(cp)
          ? cp.choices[0].text
          : ''
    )
    return text
  }
}

async function* streamable(stream: AsyncIterableOpenAIStreamReturnTypes, cb?: (chunk: ChatCompletionChunk | Completion) => void) {
  const extract = chunkToText()
  for await (const chunk of stream) {
    const text = extract(chunk)
    cb && cb(chunk)

    if (text) yield text
  }
}

type AsyncIterableOpenAIStreamReturnTypes =
  | AsyncIterable<ChatCompletionChunk>
  | AsyncIterable<Completion>

type ExtractType<T> = T extends AsyncIterable<infer U> ? U : never

type OpenAIStreamReturnTypes = ExtractType<AsyncIterableOpenAIStreamReturnTypes>


export function OpenAIStream(
  res: Response | AsyncIterableOpenAIStreamReturnTypes,
  callbacks?: OpenAIStreamCallbacks & { onChunk?: (chunk: any) => void }
): ReadableStream {
  // Annotate the internal `messages` property for recursive function calls
  const cb:
    | undefined
    | (OpenAIStreamCallbacks & {
      [__internal__OpenAIFnMessagesSymbol]?: CreateMessage[]
    } & { onChunk?: (chunk: ChatCompletionChunk | Completion) => void }) = callbacks

  let stream: ReadableStream<Uint8Array>

  if (Symbol.asyncIterator in res) {
    console.log(1);
    

    stream = readableFromAsyncIterable(streamable(res, cb?.onChunk)).pipeThrough(
      createCallbacksTransformer(
        cb?.experimental_onFunctionCall
          ? {
            ...cb,
            onFinal: undefined
          }
          : {
            ...cb
          }
      )
    )
  } else {
    console.log(2);
    
    stream = AIStream(
      res,
      parseOpenAIStream(),
      cb?.experimental_onFunctionCall
        ? {
          ...cb,
          onFinal: undefined
        }
        : {
          ...cb
        }
    )
  }


  if (cb && cb.experimental_onFunctionCall) {
    
    const functionCallTransformer = createFunctionCallTransformer(cb)
    return stream.pipeThrough(functionCallTransformer)
  } else {
    return stream.pipeThrough(
      createStreamDataTransformer(cb?.experimental_streamData)
    )
  }
}
