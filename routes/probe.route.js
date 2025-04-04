import express from "express";
import { getData } from "../controllers/probe.controller.js"; // Ensure this path is correct

const router = express.Router();

router.get("/getdata", getData);

export default router;
