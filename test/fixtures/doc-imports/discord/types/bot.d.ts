export interface ClearChannelMessagesResult {
    deleted: number;
}
export default class Bot {
    clearChannelMessages(): Promise<ClearChannelMessagesResult>;
}
