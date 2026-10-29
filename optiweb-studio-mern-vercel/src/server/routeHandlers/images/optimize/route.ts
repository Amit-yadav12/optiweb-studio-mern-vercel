import { optimizeUploadedImages } from "@/server/controllers/imagesController";
import { route } from "@/server/http/handler";


/** POST /api/v1/images/optimize — accepts one image or a multipart batch. */
export const POST = route(optimizeUploadedImages, { bucket: "images/optimize" });
