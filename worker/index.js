const PIPELINE_API_URL = "https://jugular-museum-thorn.ngrok-free.dev/api/leads/create-from-intake";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    }
  });
}

function extractJson(text) {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw error;
    }
    return JSON.parse(match[0]);
  }
}

async function parseRequestJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

async function handleQualityGate(request, env) {
  const body = await parseRequestJson(request);
  const {
    business_description = "",
    top_services = "",
    hours = "",
    service_area = ""
  } = body;

  if (!business_description || !top_services || !hours || !service_area) {
    return jsonResponse(
      {
        pass: false,
        feedback: "Please complete every required field before continuing."
      },
      400
    );
  }

  const prompt = [
    "Business description:",
    business_description,
    "",
    "Top services:",
    top_services,
    "",
    "Hours:",
    hours,
    "",
    "Service area:",
    service_area
  ].join("\n");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a quality gate for a Google Business Profile optimization service intake form.\nEvaluate whether the submission contains enough real, specific information to write compelling GBP content.\nCheck: Is the business description real and specific (not lorem ipsum, not one word, not gibberish)?\nAre the services actual services a real business would offer?\nIs there enough detail to write a compelling Google Business Profile?\nReply with JSON only: {\"pass\": true/false, \"feedback\": \"<one sentence of specific guidance if fail, empty string if pass>\"}"
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("OpenRouter error:", text);
    return jsonResponse(
      {
        pass: false,
        feedback: "Quality check is temporarily unavailable."
      },
      502
    );
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    return jsonResponse(
      {
        pass: false,
        feedback: "Quality check is temporarily unavailable."
      },
      502
    );
  }

  const parsed = extractJson(content);

  return jsonResponse({
    pass: Boolean(parsed.pass),
    feedback: parsed.pass ? "" : String(parsed.feedback || "")
  });
}

async function handleCreateCheckout(request, env) {
  const body = await parseRequestJson(request);
  
  // All fields from the form are now expected
  const requiredFields = [
    "business_name", "email", "phone", "website_url", 
    "business_description", "top_services", "hours", "service_area",
    "gbp_url", "gbp_manager_invited", "preferred_tone",
  ];

  const missing = requiredFields.filter(f => !(f in body));
  if (missing.length > 0) {
    return jsonResponse({ error: `Missing required fields: ${missing.join(", ")}` }, 400);
  }

  let lead_id;
  try {
    const pipelineResponse = await fetch(PIPELINE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!pipelineResponse.ok) {
      const errorText = await pipelineResponse.text();
      console.error("Pipeline API error:", errorText);
      throw new Error(`Pipeline API call failed: ${errorText}`);
    }

    const pipelineData = await pipelineResponse.json();
    lead_id = pipelineData.lead_id;

    if (!lead_id) {
      throw new Error("lead_id not found in pipeline response");
    }

  } catch (error) {
    console.error("Error calling pipeline API:", error);
    return jsonResponse({ error: "Failed to create lead via pipeline." }, 500);
  }

  const { email, business_name } = body;

  const formData = new URLSearchParams();
  formData.set("mode", "payment");
  formData.set("line_items[0][price]", "price_1TPFTHPxC44aX61E4c7fswyJ");
  formData.set("line_items[0][quantity]", "1");
  formData.set("metadata[lead_id]", String(lead_id));
  formData.set("metadata[business_name]", business_name);
  formData.set("customer_email", email);
  formData.set("success_url", "https://main.ai-content-starter-pack.pages.dev/success.html");
  formData.set("cancel_url", "https://269809ea.ai-content-starter-pack.pages.dev");

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formData
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("Stripe error:", text);
    return jsonResponse({ error: "Unable to create checkout session." }, 502);
  }

  const data = await response.json();

  return jsonResponse({ checkout_url: data.url });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/quality-gate") {
        return await handleQualityGate(request, env);
      }

      if (request.method === "POST" && url.pathname === "/create-checkout") {
        return await handleCreateCheckout(request, env);
      }

      return jsonResponse({ error: "Not found." }, 404);
    } catch (error) {
      console.error("Worker error:", error);
      return jsonResponse({ error: "Internal server error." }, 500);
    }
  }
};
