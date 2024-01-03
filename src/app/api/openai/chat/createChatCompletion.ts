import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';

import { ChatErrorType } from '@/types/fetch';
import { OpenAIChatStreamPayload } from '@/types/openai/chat';

import { createErrorResponse } from '../errorResponse';

interface CreateChatCompletionOptions {
  openai: OpenAI;
  payload: OpenAIChatStreamPayload;
}

export const createChatCompletion = async ({ payload, openai }: CreateChatCompletionOptions) => {
  // ============  1. preprocess messages   ============ //
  const { messages, ...params } = payload;

  // ============  2. send api   ============ //

  try {
    const response = await openai.chat.completions.create(
      {
        messages,
        ...params,
        stream: true,
      } as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
      { headers: { Accept: '*/*' } },
    );
    // const [responseClone, responseForOpenAIStream] = response.toReadableStream().tee();

    // const reader = responseClone.getReader()
    // const decoder = new TextDecoder("utf-8"); // 创建一个用于解码 UTF-8 文本的解码器
    // let chunks: any = [];

    // function read() {
    //   reader.read().then(({ done, value }) => {
    //     if (done) {
    //       const newStream = new ReadableStream({
    //         start(controller) {
    //           chunks.forEach((chunk: any) => controller.enqueue(chunk));
    //           controller.close();
    //         }
    //       });
    //       return new StreamingTextResponse(newStream);
    //       return;
    //     }
    //     // 将 Uint8Array 数据块解码为字符串
    //     const chunkAsString = decoder.decode(value, { stream: true });
    //     const chunkAsObj = JSON.parse(chunkAsString)
    //     const content: string = chunkAsObj.choices[0].delta.content
    //     chunks.push(content);
    //     if (chunkAsObj.conversation_id && chunkAsObj.parent_message_id) {
    //       console.log(chunkAsObj.conversation_id);
    //       console.log(chunkAsObj.parent_message_id);
    //     }

    //     // 继续读取下一个数据块
    //     read();
    //   }).catch((err) => {
    //     console.error('Error occurred while reading the stream:', err);
    //   });
    // }

    // // 开始读取流
    // read();

    const stream = OpenAIStream(response);
    return new StreamingTextResponse(stream);
  } catch (error) {
    // Check if the error is an OpenAI APIError
    if (error instanceof OpenAI.APIError) {
      let errorResult: any;

      // if error is definitely OpenAI APIError, there will be an error object
      if (error.error) {
        errorResult = error.error;
      }
      // Or if there is a cause, we use error cause
      // This often happened when there is a bug of the `openai` package.
      else if (error.cause) {
        errorResult = error.cause;
      }
      // if there is no other request error, the error object is a Response like object
      else {
        errorResult = { headers: error.headers, stack: error.stack, status: error.status };
      }

      // track the error at server side
      console.error(errorResult);

      return createErrorResponse(ChatErrorType.OpenAIBizError, {
        endpoint: openai.baseURL,
        error: errorResult,
      });
    }

    // track the non-openai error
    console.error(error);

    // return as a GatewayTimeout error
    return createErrorResponse(ChatErrorType.InternalServerError, {
      endpoint: openai.baseURL,
      error: JSON.stringify(error),
    });
  }
};
