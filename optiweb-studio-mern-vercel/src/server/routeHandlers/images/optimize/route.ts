import { optimizeUploadedImages } from "../../../controllers/imagesController.js";
import { route } from "../../../http/handler.js";


/** POST /api/v1/images/optimize — accepts one image or a multipart batch. */
export const POST = route(optimizeUploadedImages, { bucket: "images/optimize" });
