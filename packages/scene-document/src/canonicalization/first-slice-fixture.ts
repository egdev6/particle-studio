import type { SceneDocumentV1 } from "../schemas/scene-document-v1.js";

export const FIRST_SLICE_DOCUMENT = {
    schemaVersion: 1,
    durationUs: 1_000_000,
    playbackRange: { startUs: 0, endUs: 1_000_000 },
    loop: true,
    seed: 42,
    rootIds: ["shape-1"],
    elements: [
        {
            id: "shape-1",
            type: "shape",
            x: 16,
            y: 24,
            width: 120,
            height: 80,
            opacity: 1,
        },
    ],
    tracks: [
        {
            elementId: "shape-1",
            property: "opacity",
            interpolation: "linear",
            easing: "easeInOutQuad",
            keyframes: [
                { timeUs: 0, value: 0.25 },
                { timeUs: 1_000_000, value: 0.75 },
            ],
        },
    ],
} as const satisfies SceneDocumentV1;

export const FIRST_SLICE_CANONICAL_HEX =
    "7b226475726174696f6e5573223a313030303030302c22656c656d656e7473223a5b7b22686569676874223a38302c22" +
    "6964223a2273686170652d31222c226f706163697479223a312c2274797065223a227368617065222c22776964746822" +
    "3a3132302c2278223a31362c2279223a32347d5d2c226c6f6f70223a747275652c22706c61796261636b52616e676522" +
    "3a7b22656e645573223a313030303030302c2273746172745573223a307d2c22726f6f74496473223a5b227368617065" +
    "2d31225d2c22736368656d6156657273696f6e223a312c2273656564223a34322c22747261636b73223a5b7b22656173" +
    "696e67223a2265617365496e4f757451756164222c22656c656d656e744964223a2273686170652d31222c22696e7465" +
    "72706f6c6174696f6e223a226c696e656172222c226b65796672616d6573223a5b7b2274696d655573223a302c227661" +
    "6c7565223a302e32357d2c7b2274696d655573223a313030303030302c2276616c7565223a302e37357d5d2c2270726f" +
    "7065727479223a226f706163697479227d5d7d";
export const FIRST_SLICE_CANONICAL_SHA256 =
    "ce66f9f252023a1594da348c03577c506ca89766e56e1bfefe19b577fcb89387";
