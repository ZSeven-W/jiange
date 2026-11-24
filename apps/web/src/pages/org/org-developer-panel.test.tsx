import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildEndpointCurl,
  buildScimBaseUrl,
  extractOpenAPISchemaRef,
  filterOpenAPIEndpoints,
  flattenOpenAPIEndpoints,
  OrgDeveloperPanel,
  SCIM_ENDPOINT_REFERENCES,
  type OpenAPISpec,
} from "./org-developer-panel";

const sampleSpec: OpenAPISpec = {
  openapi: "3.1.0",
  info: {
    title: "Jiange Open API",
    version: "0.2.0",
    description: "Jiange collaborative office suite Open API and SCIM 2.0 provisioning.",
  },
  tags: [
    { name: "Docs", description: "Collaborative documents" },
    { name: "SCIM 2.0", description: "RFC 7643/7644 provisioning" },
    { name: "Webhooks", description: "Workspace webhooks" },
  ],
  components: {
    schemas: {
      ErrorResponse: { type: "object" },
      DocMeta: { type: "object" },
      SCIMUser: { type: "object" },
      SCIMError: { type: "object" },
    },
  },
  paths: {
    "/api/docs": {
      get: {
        operationId: "listDocs",
        tags: ["Docs"],
        summary: "List workspace documents",
        description: "Lists accessible documents inside a workspace.",
        parameters: [
          { name: "workspaceId", in: "query", required: true, description: "Workspace ID", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "Document list",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/DocMeta" } },
              },
            },
          },
          "401": {
            description: "Unauthorized",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
      post: {
        operationId: "createDoc",
        tags: ["Docs"],
        summary: "Create a document",
        description: "Creates a new collaborative document.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["workspaceId", "title"],
                properties: {
                  workspaceId: { type: "integer", example: 7 },
                  title: { type: "string", example: "Design RFC" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Document created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DocMeta" },
              },
            },
          },
        },
      },
    },
    "/api/docs/{id}/link": {
      put: {
        operationId: "putDocLink",
        tags: ["Docs"],
        summary: "Configure public share link",
        description: "Updates public link access policy.",
        responses: { "200": { description: "Updated link" } },
      },
    },
    "/scim/v2/Users": {
      post: {
        operationId: "scimCreateUser",
        tags: ["SCIM 2.0"],
        summary: "Provision a user via SCIM 2.0",
        description: "Creates or links a user by email and adds them to the workspace.",
        parameters: [
          { name: "workspaceId", in: "query", required: false, description: "Target workspace ID", schema: { type: "integer" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/scim+json": {
              schema: {
                type: "object",
                required: ["userName"],
                properties: {
                  userName: { type: "string", description: "Primary email address", example: "alice@example.com" },
                  displayName: { type: "string", description: "Display name", example: "Alice" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "User provisioned",
            content: {
              "application/scim+json": {
                schema: { $ref: "#/components/schemas/SCIMUser" },
              },
            },
          },
          "403": {
            description: "Admin PAT required",
            content: {
              "application/scim+json": {
                schema: { $ref: "#/components/schemas/SCIMError" },
              },
            },
          },
          "409": {
            description: "User already exists",
            content: {
              "application/scim+json": {
                schema: { $ref: "#/components/schemas/SCIMError" },
              },
            },
          },
        },
      },
    },
    "/scim/v2/Users/{uid}": {
      patch: {
        operationId: "scimPatchUser",
        tags: ["SCIM 2.0"],
        summary: "Update or deactivate a SCIM user",
        description: "Applies PatchOp to update role or set active=false to deprovision.",
        responses: { "200": { description: "Updated SCIM user" } },
      },
    },
    "/api/workspaces/{wsId}/webhooks/{wid}": {
      delete: {
        operationId: "deleteWorkspaceWebhook",
        tags: ["Webhooks"],
        summary: "Delete a workspace webhook",
        description: "Stops outbound deliveries and deletes the webhook.",
        responses: { "204": { description: "Webhook deleted" } },
      },
    },
  },
};

describe("org-developer-panel helpers", () => {
  it("formats SCIM Base URL cleanly with workspaceId", () => {
    expect(buildScimBaseUrl("https://docs.example.com/", 42)).toBe(
      "https://docs.example.com/scim/v2?workspaceId=42",
    );
    expect(buildScimBaseUrl("http://localhost:5173", 0)).toBe(
      "http://localhost:5173/scim/v2",
    );
  });

  it("flattens, filters, and builds pre-filled cURL commands for OpenAPI endpoints", () => {
    const endpoints = flattenOpenAPIEndpoints(sampleSpec);
    expect(endpoints).toHaveLength(6);

    const scimOnly = filterOpenAPIEndpoints(endpoints, "SCIM 2.0", "");
    expect(scimOnly).toHaveLength(2);

    const searched = filterOpenAPIEndpoints(endpoints, "all", "webhook");
    expect(searched).toHaveLength(1);
    expect(searched[0].method).toBe("DELETE");

    const scimPost = endpoints.find((e) => e.key === "POST /scim/v2/Users")!;
    const curl = buildEndpointCurl(scimPost, "https://docs.example.com", 7);
    expect(curl).toContain("-X POST");
    expect(curl).toContain('Authorization: Bearer $JIANGE_PAT');
    expect(curl).toContain('Content-Type: application/scim+json');
    expect(curl).toContain("https://docs.example.com/scim/v2/Users?workspaceId=7");
    expect(curl).toContain("alice@example.com");

    const webhookDel = endpoints.find((e) => e.key === "DELETE /api/workspaces/{wsId}/webhooks/{wid}")!;
    const delCurl = buildEndpointCurl(webhookDel, "https://docs.example.com", 7);
    expect(delCurl).toContain("-X DELETE");
    expect(delCurl).toContain("https://docs.example.com/api/workspaces/7/webhooks/{wid}");
  });

  it("extracts direct, array, and nested schema $ref names cleanly", () => {
    expect(extractOpenAPISchemaRef({ $ref: "#/components/schemas/SCIMUser" })).toBe("SCIMUser");
    expect(
      extractOpenAPISchemaRef({ type: "array", items: { $ref: "#/components/schemas/DocMeta" } }),
    ).toBe("DocMeta[]");
    expect(
      extractOpenAPISchemaRef({
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/AuditLogEntry" } },
          total: { type: "integer" },
        },
      }),
    ).toBe("AuditLogEntry[]");
  });

  it("includes RFC 7644 discovery and PUT methods in SCIM_ENDPOINT_REFERENCES and avoids workspaceId on public SCIM discovery cURL", () => {
    const paths = SCIM_ENDPOINT_REFERENCES.map((r) => r.path);
    expect(paths).toContain("/scim/v2/ServiceProviderConfig");
    expect(paths).toContain("/scim/v2/Schemas");
    expect(paths).toContain("/scim/v2/ResourceTypes");
    const userItem = SCIM_ENDPOINT_REFERENCES.find((r) => r.path === "/scim/v2/Users/{uid}");
    const groupItem = SCIM_ENDPOINT_REFERENCES.find((r) => r.path === "/scim/v2/Groups/{gid}");
    expect(userItem?.methods).toContain("PUT");
    expect(groupItem?.methods).toContain("PUT");

    const schemasCurl = buildEndpointCurl(
      {
        key: "GET /scim/v2/Schemas",
        method: "GET",
        path: "/scim/v2/Schemas",
        tag: "SCIM 2.0",
        tags: ["SCIM 2.0"],
        operationId: "scimListSchemas",
        summary: "List SCIM schemas",
        description: "",
        parameters: [],
        contentType: "application/scim+json",
        responses: [],
        isPublic: true,
      },
      "https://docs.example.com",
      7,
    );
    expect(schemasCurl).toContain('"https://docs.example.com/scim/v2/Schemas"');
    expect(schemasCurl).not.toContain("workspaceId=7");
  });
});

describe("OrgDeveloperPanel", () => {
  it("renders Section 1 SCIM 2.0 config and Section 2 OpenAPI 3.1 explorer for workspace admins with zero native selects", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgDeveloperPanel
          workspaceId={7}
          canAdmin={true}
          initialSpec={sampleSpec}
          initialExpandedKeys={["POST /scim/v2/Users", "GET /api/docs"]}
          originOverride="https://docs.example.com"
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("data-org-developer-panel");

    // Section 1: SCIM 2.0 (including RFC 7644 Schemas, ResourceTypes, and PUT)
    expect(html).toContain("SCIM 2.0 身份供应配置");
    expect(html).toContain("https://docs.example.com/scim/v2?workspaceId=7");
    expect(html).toContain("Authorization: Bearer &lt;admin PAT&gt;");
    expect(html).toContain("data-open-pat-manager");
    expect(html).toContain("Okta");
    expect(html).toContain("Azure AD (Entra ID)");
    expect(html).toContain("ServiceProviderConfig");
    expect(html).toContain("/scim/v2/Schemas");
    expect(html).toContain("/scim/v2/ResourceTypes");
    expect(html).toContain("/scim/v2/Users");
    expect(html).toContain("/scim/v2/Users/{uid}");
    expect(html).toContain("/scim/v2/Groups");
    expect(html).toContain("/scim/v2/Groups/{gid}");

    // Section 2: OpenAPI 3.1 Browser + schemas count badge
    expect(html).toContain("OpenAPI 3.1 开放接口浏览器");
    expect(html).toContain("OpenAPI 3.1.0 · v0.2.0");
    expect(html).toContain("共 6 个接口");
    expect(html).toContain("data-openapi-schema-count");
    expect(html).toContain("共 4 个数据模型");
    expect(html).toContain("data-openapi-tag-pills");
    expect(html).toContain("data-openapi-search");
    expect(html).toContain("下载 openapi.json");

    // HTTP method badges (GET, POST, PATCH, PUT, DELETE)
    expect(html).toContain('data-http-method="GET"');
    expect(html).toContain('data-http-method="POST"');
    expect(html).toContain('data-http-method="PATCH"');
    expect(html).toContain('data-http-method="PUT"');
    expect(html).toContain('data-http-method="DELETE"');

    // Expanded endpoint card details, response status codes, schema $ref names, & cURL
    expect(html).toContain('data-openapi-detail="POST /scim/v2/Users"');
    expect(html).toContain("Creates or links a user by email and adds them to the workspace.");
    expect(html).toContain('data-response-code="201"');
    expect(html).toContain('data-response-schema="SCIMUser"');
    expect(html).toContain('data-response-schema="SCIMError"');
    expect(html).toContain('data-response-schema="DocMeta[]"');
    expect(html).toContain('data-response-schema="ErrorResponse"');
    expect(html).toContain("复制 cURL");
    expect(html).toContain("Authorization: Bearer $JIANGE_PAT");

    // Zero native <select>
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("filters endpoints by tag pill and keyword search", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgDeveloperPanel
          workspaceId={7}
          canAdmin={true}
          initialSpec={sampleSpec}
          initialTag="SCIM 2.0"
          initialSearch="PATCH"
          originOverride="https://docs.example.com"
        />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-openapi-endpoint="PATCH /scim/v2/Users/{uid}"');
    expect(html).not.toContain('data-openapi-endpoint="GET /api/docs"');
    expect(html).not.toContain('data-openapi-endpoint="POST /scim/v2/Users"');
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("guards SCIM admin controls for regular members while keeping OpenAPI 3.1 browser accessible", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgDeveloperPanel
          workspaceId={7}
          canAdmin={false}
          initialSpec={sampleSpec}
          originOverride="https://docs.example.com"
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("data-scim-admin-guard");
    expect(html).toContain("仅空间所有者或管理员可配置 SCIM 2.0 身份供应");
    expect(html).not.toContain("data-open-pat-manager");
    expect(html).not.toContain("data-scim-base-url");
    expect(html).toContain("OpenAPI 3.1 开放接口浏览器");
    expect(html).toContain("共 6 个接口");
    expect(html).not.toMatch(/<select[\s>]/i);
  });
});
