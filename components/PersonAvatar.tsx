import React from "react";
import SmartImage from "./SmartImage";

const EMPTY_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E";

/** Leave the existing photo frame empty when no real portrait was supplied. */
type PersonAvatarProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  rotation?: -90 | 90 | 180;
};

const PersonAvatar: React.FC<PersonAvatarProps> = ({ src, rotation, style, ...props }) => {
  if (!src || src.includes("placehold.co/") || src.endsWith("/avatar-placeholder.svg")) return null;
  // Fit quarter-turn portraits into both the round cards and 3:4 profile frames.
  const quarterTurn = rotation === -90 || rotation === 90;
  return <SmartImage {...props} src={src} fallbackSrc={EMPTY_AVATAR} style={rotation ? {
    ...style,
    objectFit: quarterTurn ? "contain" : "cover",
    transform: `rotate(${rotation}deg) scale(${quarterTurn ? 4 / 3 : 1})`,
  } : style} />;
};

export default PersonAvatar;
