const ContentTypes = {
  TEXT: "text/plain",
  JSON: "application/json",
  CHATSTATE: "application/vnd.lime.chatstate+json",
  COLLECTION: "application/vnd.lime.collection+json",
  DOCUMENT_SELECT: "application/vnd.lime.document-select+json",
  LOCATION: "application/vnd.lime.location+json",
  MEDIA_LINK: "application/vnd.lime.media-link+json",
  SELECT: "application/vnd.lime.select+json",
  WEB_LINK: "application/vnd.lime.web-link+json"
} as const;
export const ContentTypeAliases: Readonly<Record<string, string>> = Object.freeze({
  text: ContentTypes.TEXT, json: ContentTypes.JSON, chatstate: ContentTypes.CHATSTATE,
  collection: ContentTypes.COLLECTION, "document-select": ContentTypes.DOCUMENT_SELECT,
  location: ContentTypes.LOCATION, "media-link": ContentTypes.MEDIA_LINK,
  select: ContentTypes.SELECT, "web-link": ContentTypes.WEB_LINK
});
export class ContentTypeRegistry {
  private aliases = new Map(Object.entries(ContentTypeAliases));
  resolve(type: string): string {
    const canonical = this.aliases.get(type) || type;
    if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\r\n]+)?$/.test(canonical)) {
      throw new Error(`Unknown content type or alias: ${type}`);
    }
    return canonical;
  }
  // Call only after an application-defined registration command is acknowledged.
  register(alias: string, type: string): void {
    if (!/^[a-z][a-z0-9-]*$/.test(alias)) throw new Error("Invalid content alias");
    const canonical = this.resolve(type);
    const current = this.aliases.get(alias);
    if (current && current !== canonical) throw new Error("Content alias is immutable");
    this.aliases.set(alias, canonical);
  }
  reset(): void { this.aliases = new Map(Object.entries(ContentTypeAliases)); }
}
export default ContentTypes;
