import React from "react";
import SmartImage from "./SmartImage";

const EMPTY_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E";

/** Leave the existing photo frame empty when no real portrait was supplied. */
const PersonAvatar: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = ({ src, ...props }) => {
  if (!src || src.includes("placehold.co/") || src.endsWith("/avatar-placeholder.svg")) return null;
  return <SmartImage {...props} src={src} fallbackSrc={EMPTY_AVATAR} />;
};

export default PersonAvatar;
