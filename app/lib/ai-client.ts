// AI Client for both Gemini and Gemma models
export type ModelType = "gemini" | "gemma"

export interface AIModel {
  name: string
  type: ModelType
  displayName: string
  description: string
  inputTokenLimit: number
  outputTokenLimit: number
  requestsPerMinute?: number
  tokensPerMinute?: number
  supportedGenerationMethods: string[]
  temperature?: number
  topP?: number
  topK?: number
}

export interface GenerateContentRequest {
  contents: Array<{
    parts: Array<{
      text: string
    }>
  }>
  generationConfig: {
    temperature: number
    maxOutputTokens: number
    thinkingConfig?: {
      thinkingBudget: number
    }
  }
}

export interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
      }>
    }
    finishReason?: string
    index?: number
    tokenCount?: number
    safetyRatings?: Array<{
      category: string
      probability: string
    }>
  }>
}

// Determine model type from model name
export function getModelType(modelName: string): ModelType | undefined {
  if (modelName.startsWith("models/gemini-")) {
    return "gemini"
  } else if (modelName.startsWith("models/gemma-")) {
    return "gemma"
  }
  return undefined
}

// Get the appropriate API endpoint for a model
export function getAPIEndpoint(modelName: string): string {
  const modelType = getModelType(modelName)

  switch (modelType) {
    case "gemini":
      return `https://generativelanguage.googleapis.com/v1beta/models/${modelName.replace(
        "models/",
        ""
      )}:generateContent`
    case "gemma":
      // Gemma models use the same endpoint as Gemini but with different authentication
      return `https://generativelanguage.googleapis.com/v1beta/models/${modelName.replace(
        "models/",
        ""
      )}:generateContent`
    default:
      throw new Error(`Unsupported model type: ${modelType}`)
  }
}

// Generate content using the appropriate API
export async function generateContent(
  modelName: string,
  apiKey: string,
  request: GenerateContentRequest
): Promise<GenerateContentResponse> {
  const modelType = getModelType(modelName)

  if (!modelType) {
    throw new Error(`Unsupported model: ${modelName}`)
  }

  const endpoint = getAPIEndpoint(modelName)

  console.log(
    `[AI-CLIENT] Making ${modelType.toUpperCase()} API call to ${modelName}`
  )
  console.log(`[AI-CLIENT] Endpoint: ${endpoint}`)

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  // Add API key as query parameter for both Gemini and Gemma
  const url = `${endpoint}?key=${apiKey}`

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  })

  console.log(
    `[AI-CLIENT] API response status: ${response.status} ${response.statusText}`
  )

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`[AI-CLIENT] API error response: ${errorText}`)

    // Provide more specific error messages based on status codes
    if (response.status === 404) {
      const error = new Error(
        `Model ${modelName} not found. Please check if the model name is correct and you have access to it.`
      )
      ;(error as any).errorText = errorText
      throw error
    } else if (response.status === 401 || response.status === 403) {
      const error = new Error(
        `Authentication error. Please check your API key and permissions for model ${modelName}.`
      )
      ;(error as any).errorText = errorText
      throw error
    } else {
      const error = new Error(
        `${modelType.toUpperCase()} API error: ${response.statusText}`
      )
      ;(error as any).errorText = errorText
      throw error
    }
  }

  const result = (await response.json()) as GenerateContentResponse

  // No longer validating here, will be handled in the calling function
  // if (!result.candidates?.[0]?.content?.parts?.[0]?.text) {
  //   console.error(`[AI-CLIENT] Invalid response structure:`, result);
  //   throw new Error(`No valid response from ${modelType.toUpperCase()} API`);
  // }

  return result
}



// Fetch available models from the API
export async function fetchAvailableModels(apiKey: string): Promise<AIModel[]> {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    )

    if (!response.ok) {
      throw new Error(
        `Failed to fetch models: ${response.status} ${response.statusText}`
      )
    }

    const data = (await response.json()) as { models?: any[] }

    // Fallback data for models that might not have it in the API response
    const modelRateLimits: Record<string, { rpm?: number; tpm: number }> = {
      // Text-out models
      "models/gemini-2.5-pro": { rpm: 5, tpm: 250000 },
      "models/gemini-2.5-flash": { rpm: 10, tpm: 250000 },
      "models/gemini-2.5-flash-lite-preview-06-17": { rpm: 15, tpm: 250000 },
      "models/gemini-2.0-flash": { rpm: 15, tpm: 1000000 },
      "models/gemini-2.0-flash-lite": { rpm: 30, tpm: 1000000 },

      // Gemma models
      "models/gemma-3": { rpm: 30, tpm: 15000 },
      "models/gemma-3n": { rpm: 30, tpm: 15000 },

      // Other models
      "models/gemini-embedding": { tpm: 30000 },

      // Deprecated models
      "models/gemini-1.5-flash": { rpm: 15, tpm: 250000 },
      "models/gemini-1.5-flash-8b": { rpm: 15, tpm: 250000 },
    }

    // console.log(`[AI-CLIENT] Raw API response:`, data);
    console.log(`[AI-CLIENT] Models array length:`, data.models?.length || 0)

    // Filter for generation models and add type information
    const generationModels =
      data.models
        ?.filter((model: any) => {
          // console.log(`[AI-CLIENT] Checking model:`, model.name, 'Methods:', model.supportedGenerationMethods);
          const modelType = getModelType(model.name)
          return (
            model.supportedGenerationMethods?.includes("generateContent") &&
            modelType
          )
        })
        .map((model: any) => {
          const fallbackLimits = modelRateLimits[model.name]

          return {
            name: model.name,
            type: getModelType(model.name)!,
            displayName: model.displayName,
            description: model.description,
            inputTokenLimit: model.inputTokenLimit,
            outputTokenLimit: model.outputTokenLimit,
            requestsPerMinute: model.requestsPerMinute ?? fallbackLimits?.rpm,
            tokensPerMinute: model.tokensPerMinute ?? fallbackLimits?.tpm,
            supportedGenerationMethods: model.supportedGenerationMethods,
            temperature: model.temperature,
            topP: model.topP,
            topK: model.topK,
          }
        }) || []

    console.log(
      `[AI-CLIENT] Found ${generationModels.length} generation models`
    )
    return generationModels
  } catch (error) {
    console.error("[AI-CLIENT] Error fetching models:", error)
    throw error
  }
}
